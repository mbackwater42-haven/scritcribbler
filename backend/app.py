"""
Scrit Cribbler backend (v2) - runs on the Windows workstation.

Called only by the scrit-recorder service on the Foundry server, over HTTPS with a
bearer token. The server records the session in 10-minute chunks per speaker and
sends each file here as it completes; after the session it sends the full labeled
transcript for summarizing.

  GET  /health            no auth
  GET  /models            auth
  POST /transcribe-chunk  auth  multipart: audio (file), speaker (str)
                          -> { status, segments: [{start, end, text}] }   (seconds, file-relative)
  POST /chunk-notes       auth  JSON: { session_name, chunk: {index, start, transcript} }
                          -> { status, notes }   (called during the session, once per chunk)
  POST /summarize         auth  JSON: { session_name, world, duration_seconds, speakers,
                                        chunks: [{index, start, transcript, notes?}] }
                          -> { status, summary (markdown), model }   (reuses notes when given)
"""
import hmac
import logging
import os
import re
import subprocess
import tempfile
import threading
from datetime import datetime, timezone

import numpy as np
import requests
import whisper
from cheroot.ssl.builtin import BuiltinSSLAdapter
from cheroot.wsgi import Server as WSGIServer
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

OLLAMA_API_URL = os.getenv("OLLAMA_API_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "mistral")
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
FFMPEG_PATH = os.getenv("FFMPEG_PATH", "ffmpeg")
BIND = os.getenv("BIND", "0.0.0.0")
PORT = int(os.getenv("PORT", "5443"))
TLS_CERT = os.getenv("TLS_CERT", "certs/desktop.crt")
TLS_KEY = os.getenv("TLS_KEY", "certs/desktop.key")
BACKEND_TOKEN = os.getenv("BACKEND_TOKEN", "")

if not BACKEND_TOKEN:
    raise SystemExit("BACKEND_TOKEN is not set in .env - refusing to start without auth")

# whisper's load_audio() shells out to a bare "ffmpeg"; make sure it is on PATH.
_ffmpeg_dir = os.path.dirname(FFMPEG_PATH)
if _ffmpeg_dir and _ffmpeg_dir not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("scrit-backend")

logger.info(f"Loading Whisper model '{WHISPER_MODEL}'...")
whisper_model = whisper.load_model(WHISPER_MODEL)
logger.info("Whisper model loaded.")

# Whisper and Ollama share one machine; never run two jobs at once.
gpu_lock = threading.Lock()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # a 10-min Opus chunk is ~2 MB


@app.before_request
def require_token():
    if request.path == "/health":
        return None
    header = request.headers.get("Authorization", "")
    given = header[7:] if header.startswith("Bearer ") else ""
    if not hmac.compare_digest(given.encode(), BACKEND_TOKEN.encode()):
        return jsonify({"status": "error", "error": "unauthorized"}), 401
    return None


@app.errorhandler(Exception)
def on_error(e):
    code = getattr(e, "code", 500)
    if not isinstance(code, int):
        code = 500
    if code >= 500:
        logger.exception("Request failed")
    return jsonify({"status": "error", "error": str(e)}), code


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()})


@app.route("/models", methods=["GET"])
def models():
    return jsonify({"status": "success", "whisper": WHISPER_MODEL, "ollama": OLLAMA_MODEL, "num_ctx": OLLAMA_NUM_CTX})


# ------------------------------------------------------------------ transcription

# Whisper "hears" these in silence or noise. Dropped only when they are the whole segment.
HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching!", "thanks for watching.",
    "thank you for watching.", "thank you for watching!", "you", "you.", "bye.", "bye!",
    "please subscribe.", "subtitles by the amara.org community",
}


def decode_to_wav(input_path):
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    try:
        subprocess.run(
            [FFMPEG_PATH, "-y", "-loglevel", "error", "-i", input_path,
             "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", out],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg decode failed: {e.stderr.decode(errors='replace')}")
    except FileNotFoundError:
        raise RuntimeError(f"ffmpeg not found at '{FFMPEG_PATH}'. Set FFMPEG_PATH in .env")
    return out


SAMPLE_RATE = 16000
FRAME = 320                   # 20 ms frames for the energy check
FRAME_RMS_VOICED = 0.01       # ~ -40 dBFS; WebRTC noise suppression leaves silence far below this
MIN_VOICED_RATIO = 0.15       # segment must be at least this much actual sound
# Anything outside Latin script + common punctuation (e.g. "Il歡迎 you") is a silence hallucination
# when the language is forced to English.
NON_LATIN = re.compile(r"[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\u20AC\u2122]")


def voiced_frames(audio):
    """Boolean per 20 ms frame: does it contain sound, not just silence/noise floor."""
    n = len(audio) // FRAME
    if n == 0:
        return np.zeros(0, dtype=bool)
    frames = audio[: n * FRAME].reshape(n, FRAME)
    return np.sqrt(np.mean(frames ** 2, axis=1)) > FRAME_RMS_VOICED


def voiced_ratio(voiced, start, end):
    a = int(start * SAMPLE_RATE / FRAME)
    b = max(a + 1, int(end * SAMPLE_RATE / FRAME))
    span = voiced[a:b]
    return float(span.mean()) if len(span) else 0.0


# Silence compaction: per-speaker tracks are mostly silence, and Whisper (30 s windows)
# mis-hears or loses short lines surrounded by it. Only the speech regions are sent,
# joined with short gaps, and word times are mapped back to the original track.
MERGE_GAP_S = 0.6     # speech closer than this is one region
PAD_S = 0.3           # keep a little audio around each region
JOIN_GAP_S = 0.5      # silence inserted between regions in the compact clip


def speech_regions(voiced):
    """[(start_s, end_s)] of speech in the original track, padded and merged."""
    f = FRAME / SAMPLE_RATE
    regions = []
    idx = np.flatnonzero(voiced)
    if len(idx) == 0:
        return regions
    run_start = prev = idx[0]
    for i in idx[1:]:
        if (i - prev) * f > MERGE_GAP_S:
            regions.append((run_start * f, (prev + 1) * f))
            run_start = i
        prev = i
    regions.append((run_start * f, (prev + 1) * f))
    total = len(voiced) * f
    padded = []
    for a, b in regions:
        a, b = max(0.0, a - PAD_S), min(total, b + PAD_S)
        if padded and a <= padded[-1][1]:
            padded[-1] = (padded[-1][0], b)
        else:
            padded.append((a, b))
    return padded


def compact(audio, regions):
    """Join speech regions; return (clip, spans) with spans = [(clip_start, orig_start, length)]."""
    gap = np.zeros(int(JOIN_GAP_S * SAMPLE_RATE), dtype=audio.dtype)
    parts, spans, pos = [], [], 0.0
    for a, b in regions:
        piece = audio[int(a * SAMPLE_RATE):int(b * SAMPLE_RATE)]
        spans.append((pos, a, len(piece) / SAMPLE_RATE))
        parts += [piece, gap]
        pos += len(piece) / SAMPLE_RATE + JOIN_GAP_S
    return np.concatenate(parts), spans


def to_original(t, spans):
    """Clip time -> (original time, region index). Times in a join gap snap to the nearer region edge."""
    for i, (clip_start, orig_start, length) in enumerate(spans):
        if t > clip_start + length:
            continue
        if t >= clip_start:
            return orig_start + (t - clip_start), i
        if i > 0:
            prev_clip_end = spans[i - 1][0] + spans[i - 1][2]
            if t - prev_clip_end < clip_start - t:
                return spans[i - 1][1] + spans[i - 1][2], i - 1
        return orig_start, i
    _, orig_start, length = spans[-1]
    return orig_start + length, len(spans) - 1


@app.route("/transcribe-chunk", methods=["POST"])
def transcribe_chunk():
    audio_file = request.files.get("audio")
    if not audio_file or not audio_file.filename:
        return jsonify({"status": "error", "error": "No audio file provided"}), 400
    speaker = request.form.get("speaker", "?")

    temp_in = temp_wav = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(audio_file.filename)[1]) as tmp:
            audio_file.save(tmp.name)
            temp_in = tmp.name
        temp_wav = decode_to_wav(temp_in)
        audio = whisper.load_audio(temp_wav)  # float32 mono 16 kHz
        voiced = voiced_frames(audio)
        regions = speech_regions(voiced)
        if not regions:
            logger.info(f"  {speaker}: no speech in chunk")
            return jsonify({"status": "success", "segments": [], "dropped": {}})
        clip, spans = compact(audio, regions)

        with gpu_lock:
            logger.info(f"Transcribing chunk for {speaker}: {len(audio) / SAMPLE_RATE:.0f} s track -> "
                        f"{len(clip) / SAMPLE_RATE:.0f} s of speech in {len(regions)} regions")
            result = whisper_model.transcribe(
                clip,
                language="en",
                fp16=False,
                # Stops one misheard line from snowballing into the next.
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                logprob_threshold=-1.0,
                word_timestamps=True,
            )

        segments, dropped = [], {"phrase": 0, "confidence": 0, "repetition": 0, "script": 0, "silence": 0}
        for seg in result.get("segments", []):
            if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0:
                dropped["confidence"] += 1
                continue
            if seg.get("compression_ratio", 0) > 2.4:
                dropped["repetition"] += 1
                continue
            # Rebuild lines from words, split at speech-region boundaries: two lines said
            # 30 s apart sit 0.5 s apart in the clip and may share a Whisper segment.
            groups = {}
            for w in seg.get("words", []):
                if not w.get("word", "").strip():
                    continue
                start, region = to_original(w["start"], spans)
                end, _ = to_original(w["end"], spans)
                g = groups.setdefault(region, {"start": start, "end": end, "words": []})
                g["end"] = max(g["end"], end)
                g["words"].append(w["word"])
            for g in groups.values():
                text = "".join(g["words"]).strip()
                if not text:
                    continue
                if text.lower() in HALLUCINATIONS:
                    dropped["phrase"] += 1
                elif NON_LATIN.search(text):
                    dropped["script"] += 1
                elif voiced_ratio(voiced, g["start"], g["end"]) < MIN_VOICED_RATIO:
                    dropped["silence"] += 1
                else:
                    segments.append({"start": round(g["start"], 2), "end": round(g["end"], 2), "text": text})

        segments.sort(key=lambda x: x["start"])
        logger.info(f"  {speaker}: kept {len(segments)}, dropped {dropped}")
        return jsonify({"status": "success", "segments": segments, "dropped": dropped})
    finally:
        for p in (temp_in, temp_wav):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass


# ------------------------------------------------------------------ summarization

GROUNDING = """Rules:
- Use ONLY what the transcript states. Do not invent events, outcomes, names or motives.
- Do not assume a fight, scene or session ended unless the transcript says so.
- Table talk (rules questions, snacks, jokes, scheduling) is not story; leave it out.
- Speakers are labeled "Character (Player)". "GM (...)" is the game master, who narrates and voices every NPC.
- If something is unclear or cut off, say so briefly rather than guessing."""


def ollama(prompt, num_predict):
    with gpu_lock:
        r = requests.post(
            OLLAMA_API_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                # Sampling settings must be inside "options"; top-level ones are ignored.
                "options": {"temperature": 0.2, "num_ctx": OLLAMA_NUM_CTX, "num_predict": num_predict},
            },
            timeout=1800,
        )
    if r.status_code != 200:
        raise RuntimeError(f"Ollama failed ({r.status_code}): {r.text[:300]}")
    return r.json().get("response", "").strip()


def approx_tokens(text):
    return len(text) // 4


def fit(text, budget_tokens):
    """Hard cap so a prompt never silently overflows num_ctx (Ollama truncates the start)."""
    max_chars = budget_tokens * 4
    return text if len(text) <= max_chars else text[:max_chars] + "\n[... transcript truncated to fit ...]"


def chunk_notes(session_name, chunk):
    budget = OLLAMA_NUM_CTX - 1200  # room for instructions + answer
    prompt = f"""You are taking notes on part of a tabletop RPG session recording ("{session_name}"), segment starting at {chunk['start']}.

{GROUNDING}

Transcript segment:
{fit(chunk['transcript'], budget)}

Write concise bullet-point notes of what happened in the story in this segment: actions, discoveries, decisions, fights and their outcomes, NPCs met (with names as spoken), places, items gained or lost, and unresolved questions. Use "- " bullets only, no headings, no preamble. If nothing story-relevant happened, write "- (no story events)"."""
    return ollama(prompt, 500)


def condense(session_name, notes_block):
    prompt = f"""Below are consecutive note sets from one tabletop RPG session ("{session_name}"). Merge them into one shorter chronological bullet list, keeping every concrete event, name, item and open question. Drop duplicates and "(no story events)". Use "- " bullets only, no preamble.

{notes_block}"""
    return ollama(prompt, 900)


NO_STORY = "NO_STORY"


def is_no_story(notes_text):
    """True when chunk notes hold nothing but "(no story events)" markers."""
    lines = [l.strip(" -*\t") for l in notes_text.splitlines() if l.strip(" -*\t")]
    return all("no story events" in l.lower() for l in lines)


def final_recap(meta, notes):
    # The world/campaign title is deliberately NOT given to the model: a title like
    # "Cursed Dragon of Phandelver" made Mistral fill the recap with the published
    # adventure (Cragmaw Hideout, goblins) instead of what was actually said.
    minutes = int(meta.get("duration_seconds", 0) / 60)
    speakers = ", ".join(meta.get("speakers", [])) or "unknown"
    prompt = f"""You are writing a recap of a recorded tabletop RPG session, for the players to read.

Length: {minutes} minutes
Speakers: {speakers}

{GROUNDING}
- Every name, place, creature and item you mention MUST appear in the notes below. Do not use anything you know about published adventures or settings.
- If the notes contain no story events (only microphone checks, setup or table talk), reply with exactly {NO_STORY} and nothing else.

Chronological notes from the session:
{notes}

Write the recap in Markdown. Use only the sections below that the notes actually support, in this order. Leave out any section you would have to guess to fill. Nothing before the first heading.

## Summary
One or two short paragraphs telling what happened, in past tense, third person, using character names.

## Key Events
- Bulleted, chronological.

## People & Places
- NPCs and locations named in the notes, one line each.

## Loot & Rewards
- Items, money, experience or favors gained or lost.

## Open Threads
- Unresolved questions, promises, and where the party stopped."""
    return ollama(prompt, 1600)


@app.route("/chunk-notes", methods=["POST"])
def chunk_notes_route():
    body = request.get_json(silent=True) or {}
    chunk = body.get("chunk") or {}
    if not str(chunk.get("transcript", "")).strip():
        return jsonify({"status": "success", "notes": "- (no story events)"})
    logger.info(f"Notes for '{body.get('session_name', 'Session')}' chunk {chunk.get('index')} ({approx_tokens(chunk['transcript'])} tokens)")
    return jsonify({"status": "success", "notes": chunk_notes(body.get("session_name", "Session"), chunk)})


@app.route("/summarize", methods=["POST"])
def summarize():
    meta = request.get_json(silent=True) or {}
    chunks = [c for c in meta.get("chunks", []) if str(c.get("transcript", "")).strip() or c.get("notes")]
    if not chunks:
        return jsonify({"status": "error", "error": "No transcript text to summarize"}), 400
    name = meta.get("session_name", "Session")
    logger.info(f"Summarizing '{name}': {len(chunks)} chunks")

    notes = []
    for c in chunks:
        if c.get("notes"):
            chunk_text = c["notes"]
        else:
            logger.info(f"  notes for chunk {c.get('index')} ({approx_tokens(c['transcript'])} tokens)")
            chunk_text = chunk_notes(name, c)
        notes.append(f"[{c.get('start', '?')}]\n{chunk_text}")

    # Condense in groups until the notes fit comfortably in one final prompt.
    notes_budget = max(OLLAMA_NUM_CTX - 2500, 1500)
    while approx_tokens("\n\n".join(notes)) > notes_budget and len(notes) > 1:
        logger.info(f"  condensing {len(notes)} note sets")
        notes = [condense(name, "\n\n".join(notes[i:i + 4])) for i in range(0, len(notes), 4)]

    if all(is_no_story(n.split("\n", 1)[-1]) for n in notes):
        logger.info("  every chunk is '(no story events)'; skipping final recap")
        return jsonify({"status": "success", "summary": NO_STORY, "model": {"whisper": WHISPER_MODEL, "ollama": OLLAMA_MODEL}})

    recap = final_recap(meta, fit("\n\n".join(notes), notes_budget))
    if NO_STORY in recap[:40]:
        recap = NO_STORY
    # Models sometimes open with a sentence before the first heading; drop it.
    first = recap.find("## ")
    if first > 0:
        recap = recap[first:]
    recap = re.sub(r"\n{3,}", "\n\n", recap).strip()
    logger.info(f"Recap done ({len(recap)} chars)")
    return jsonify({"status": "success", "summary": recap, "model": {"whisper": WHISPER_MODEL, "ollama": OLLAMA_MODEL}})


if __name__ == "__main__":
    server = WSGIServer((BIND, PORT), app, numthreads=4)
    server.ssl_adapter = BuiltinSSLAdapter(TLS_CERT, TLS_KEY)
    logger.info(f"Scrit Cribbler backend on https://{BIND}:{PORT} (whisper={WHISPER_MODEL}, ollama={OLLAMA_MODEL}, num_ctx={OLLAMA_NUM_CTX})")
    try:
        server.start()
    except KeyboardInterrupt:
        server.stop()
