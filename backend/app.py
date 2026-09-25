"""
Scrit Cribbler backend (v3) - runs on the Windows workstation.

Called only by the scrit-recorder service on the Foundry server, over HTTPS with a
bearer token. The server records the session in 10-minute chunks per speaker and
sends each file here as it completes; after the session it sends the full labeled
transcript for summarizing.

  GET  /health            no auth
  GET  /models            auth
  POST /transcribe-chunk  auth  multipart: audio (file), speaker (str),
                                vocab (optional, newline-separated campaign names),
                                model (optional Whisper size override, for testing)
                          -> { status, segments: [{start, end, text}], dropped, model }
  POST /chunk-notes       auth  JSON: { session_name, vocab?, chunk: {index, start, transcript} }
                          -> { status, notes }   (called during the session, once per chunk)
  POST /summarize         auth  JSON: { session_name, duration_seconds, speakers, vocab?, previous_recap?,
                                        chunks: [{index, start, transcript, notes?}] }
                          -> { status, summary (markdown) | "NO_STORY", model }
"""
import hmac
import logging
import os
import re
import tempfile
import threading
from datetime import datetime, timezone

import numpy as np
import requests
from cheroot.ssl.builtin import BuiltinSSLAdapter
from cheroot.wsgi import Server as WSGIServer
from dotenv import load_dotenv
from faster_whisper import WhisperModel, decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps
from flask import Flask, jsonify, request

load_dotenv()

OLLAMA_API_URL = os.getenv("OLLAMA_API_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "mistral")
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))
# Ollama unloads a model after 5 idle minutes by default, so each 10-minute chunk paid the
# full load again (notes took 114 s on a short clip). Keep it loaded across chunks.
OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")
WHISPER_THREADS = int(os.getenv("WHISPER_THREADS", "0"))  # 0 = let CTranslate2 decide
ALLOWED_MODELS = {"tiny", "base", "small", "medium", "tiny.en", "base.en", "small.en", "medium.en", "large-v3", "large-v3-turbo"}
BIND = os.getenv("BIND", "0.0.0.0")
PORT = int(os.getenv("PORT", "5443"))
TLS_CERT = os.getenv("TLS_CERT", "certs/desktop.crt")
TLS_KEY = os.getenv("TLS_KEY", "certs/desktop.key")
BACKEND_TOKEN = os.getenv("BACKEND_TOKEN", "")

if not BACKEND_TOKEN:
    raise SystemExit("BACKEND_TOKEN is not set in .env - refusing to start without auth")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("scrit-backend")

# Whisper and Ollama share one machine; never run two jobs at once.
gpu_lock = threading.Lock()

_models = {}


def whisper_model(name):
    """Load (once) and return a faster-whisper model. Runs on CPU; int8 is ~4x faster than fp32."""
    if name not in _models:
        logger.info(f"Loading faster-whisper '{name}' ({WHISPER_COMPUTE})...")
        _models[name] = WhisperModel(name, device="cpu", compute_type=WHISPER_COMPUTE, cpu_threads=WHISPER_THREADS)
        logger.info(f"Whisper '{name}' loaded.")
    return _models[name]


whisper_model(WHISPER_MODEL)

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
    return jsonify({"status": "success", "engine": "faster-whisper", "whisper": WHISPER_MODEL,
                    "compute": WHISPER_COMPUTE, "ollama": OLLAMA_MODEL, "num_ctx": OLLAMA_NUM_CTX,
                    "keep_alive": OLLAMA_KEEP_ALIVE})


# ------------------------------------------------------------------ transcription

SAMPLE_RATE = 16000

# Whisper "hears" these in silence or noise. Dropped only when they are the whole line.
HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching!", "thanks for watching.",
    "thank you for watching.", "thank you for watching!", "you", "you.", "bye.", "bye!",
    "please subscribe.", "subtitles by the amara.org community",
}
# Anything outside Latin script + common punctuation (e.g. "Il歡迎 you") is a mis-hearing
# when the language is forced to English.
NON_LATIN = re.compile(r"[^\u0000-ɏḀ-ỿ -⁯€™]")

# Silence compaction: per-speaker tracks are mostly silence, and Whisper (30 s windows)
# mis-hears or loses short lines surrounded by it. Only speech regions (Silero VAD) are
# sent, joined with short gaps, and word times are mapped back to the original track.
VAD = VadOptions(threshold=0.5, min_silence_duration_ms=600, speech_pad_ms=300, min_speech_duration_ms=150)
JOIN_GAP_S = 0.5
MAX_VOCAB_CHARS = 700  # hotwords share Whisper's ~224-token prompt budget


def speech_regions(audio):
    """[(start_s, end_s)] of speech in the original track (Silero VAD, padded, merged)."""
    regions = []
    for ts in get_speech_timestamps(audio, VAD):
        a, b = ts["start"] / SAMPLE_RATE, ts["end"] / SAMPLE_RATE
        if regions and a <= regions[-1][1]:
            regions[-1] = (regions[-1][0], max(b, regions[-1][1]))
        else:
            regions.append((a, b))
    return regions


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


def level_db(audio, start, end):
    """Loudness of a line on this track (dBFS). The recorder uses it to tell a speaker's own
    mic from their voice bleeding into another player's mic."""
    span = audio[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)]
    if len(span) == 0:
        return -99.0
    rms = float(np.sqrt(np.mean(span.astype(np.float64) ** 2)))
    return round(20 * np.log10(max(rms, 1e-6)), 1)


def parse_vocab(raw):
    """Newline/comma separated names -> de-duplicated list, capped to the hotword budget."""
    out, seen, size = [], set(), 0
    for term in re.split(r"[\n,]", raw or ""):
        term = term.strip()
        if not term or term.lower() in seen:
            continue
        if size + len(term) + 2 > MAX_VOCAB_CHARS:
            break
        seen.add(term.lower())
        out.append(term)
        size += len(term) + 2
    return out


@app.route("/transcribe-chunk", methods=["POST"])
def transcribe_chunk():
    audio_file = request.files.get("audio")
    if not audio_file or not audio_file.filename:
        return jsonify({"status": "error", "error": "No audio file provided"}), 400
    speaker = request.form.get("speaker", "?")
    vocab = parse_vocab(request.form.get("vocab", ""))
    model_name = request.form.get("model") or WHISPER_MODEL
    if model_name not in ALLOWED_MODELS:
        return jsonify({"status": "error", "error": f"unknown model {model_name}"}), 400

    temp_in = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(audio_file.filename)[1]) as tmp:
            audio_file.save(tmp.name)
            temp_in = tmp.name
        audio = decode_audio(temp_in, sampling_rate=SAMPLE_RATE)  # float32 mono 16 kHz
        regions = speech_regions(audio)
        if not regions:
            logger.info(f"  {speaker}: no speech in chunk")
            return jsonify({"status": "success", "segments": [], "dropped": {}, "model": model_name})
        clip, spans = compact(audio, regions)

        with gpu_lock:
            model = whisper_model(model_name)
            logger.info(f"Transcribing {speaker} with '{model_name}': {len(audio) / SAMPLE_RATE:.0f} s track -> "
                        f"{len(clip) / SAMPLE_RATE:.0f} s speech in {len(regions)} regions, {len(vocab)} vocab terms")
            seg_iter, _info = model.transcribe(
                clip,
                language="en",
                beam_size=5,
                word_timestamps=True,
                # Stops one misheard line from snowballing into the next.
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                vad_filter=False,  # already compacted with the same VAD
                hotwords=", ".join(vocab) if vocab else None,
            )
            raw_segments = list(seg_iter)  # the generator does the work; keep it inside the lock

        segments, dropped = [], {"phrase": 0, "confidence": 0, "repetition": 0, "script": 0}
        for seg in raw_segments:
            if seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0:
                dropped["confidence"] += 1
                continue
            if seg.compression_ratio > 2.4:
                dropped["repetition"] += 1
                continue
            # Rebuild lines from words, split at speech-region boundaries: two lines said
            # 30 s apart sit 0.5 s apart in the clip and may share a Whisper segment.
            groups = {}
            for w in seg.words or []:
                if not w.word.strip():
                    continue
                start, region = to_original(w.start, spans)
                end, _ = to_original(w.end, spans)
                g = groups.setdefault(region, {"start": start, "end": end, "words": []})
                g["end"] = max(g["end"], end)
                g["words"].append(w.word)
            for g in groups.values():
                text = "".join(g["words"]).strip()
                if not text:
                    continue
                if text.lower() in HALLUCINATIONS:
                    dropped["phrase"] += 1
                elif NON_LATIN.search(text):
                    dropped["script"] += 1
                else:
                    segments.append({"start": round(g["start"], 2), "end": round(g["end"], 2), "text": text,
                                     "level": level_db(audio, g["start"], g["end"])})

        segments.sort(key=lambda x: x["start"])
        logger.info(f"  {speaker}: kept {len(segments)}, dropped {dropped}")
        return jsonify({"status": "success", "segments": segments, "dropped": dropped, "model": model_name})
    finally:
        if temp_in and os.path.exists(temp_in):
            try:
                os.remove(temp_in)
            except OSError:
                pass


# ------------------------------------------------------------------ summarization

GROUNDING = """Rules:
- Use ONLY what the transcript states. Do not invent events, outcomes, names or motives.
- Do not assume a fight, scene or session ended unless the transcript says so.
- Table talk (rules questions, snacks, jokes, scheduling) is not story; leave it out.
- Speakers are labeled "Character (Player)". "GM (...)" is the game master, who narrates and voices every NPC.
- Never add up, total or calculate numbers (damage, gold, hit points). Only repeat numbers exactly as spoken.
- If something is unclear or cut off, say so briefly rather than guessing."""


def vocab_rule(vocab):
    """Correct spellings for campaign names. They fix mis-hearings; they are not facts to add."""
    if not vocab:
        return ""
    return ("\n- Known names in this campaign: " + ", ".join(vocab) + ". The transcript was made by speech "
            "recognition, so when a word is clearly a mis-hearing of one of these (for example a similar-sounding "
            "word used as a name), use the known spelling. Never mention a known name the transcript does not refer to.")


def ollama(prompt, num_predict):
    with gpu_lock:
        r = requests.post(
            OLLAMA_API_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "keep_alive": OLLAMA_KEEP_ALIVE,  # top-level field, not an option
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


def chunk_notes(session_name, chunk, vocab):
    budget = OLLAMA_NUM_CTX - 1400  # room for instructions + answer
    prompt = f"""You are taking notes on part of a tabletop RPG session recording ("{session_name}"), segment starting at {chunk['start']}.

{GROUNDING}{vocab_rule(vocab)}

Transcript segment:
{fit(chunk['transcript'], budget)}

Write concise bullet-point notes of what happened in the story in this segment: actions, discoveries, decisions, fights and their outcomes, NPCs met (with names as spoken), places, items gained or lost, and unresolved questions. Use "- " bullets only, no headings, no preamble. If nothing story-relevant happened, write "- (no story events)"."""
    return ollama(prompt, 500)


def condense(session_name, notes_block):
    prompt = f"""Below are consecutive note sets from one tabletop RPG session ("{session_name}"). Merge them into one shorter chronological bullet list, keeping every concrete event, name, item and open question. Drop duplicates and "(no story events)". Never add up or calculate numbers. Use "- " bullets only, no preamble.

{notes_block}"""
    return ollama(prompt, 900)


# Player recaps carry no dice/combat numbers. Prompt rules alone did not hold with Mistral 7B
# (it kept every damage number and summed two stated totals into a new one), so numbers are
# removed from the notes before the final recap and from the recap itself.
_DICE = [
    # parentheticals about mechanics: "(total of 38)", "(not resistant to lightning)", "(18 to hit)"
    (re.compile(r"\s*\([^()]*\b(?:total|damage|to hit|hit points?|hp|resistan\w*|vulnerab\w*|AC|DC|saving throw|save)\b[^()]*\)", re.I), ""),
    # "a total of 116" / "another 18" / "22" right before "[type] damage"
    (re.compile(r"\b(?:a total of |total of |another |an additional |an extra |additional |extra )?\d+\s+(?=(?:[a-z]+\s+)?damage\b)", re.I), ""),
    # attack rolls: "hitting for 23", "that is a 23 to hit", "rolled a 17"
    (re.compile(r"\bhitting for \d+", re.I), "hitting"),
    (re.compile(r",?\s*(?:that is |which is |with |for |rolling |rolled |rolls |a roll of )?(?:a |an )?\d+\s+to hit\b", re.I), ""),
    (re.compile(r"\b(?:rolled|rolls|rolling) (?:a |an )?\d+\b", re.I), "rolled"),
    (re.compile(r"\b\d+\s*(?:hit points|hp)\b", re.I), "hit points"),
    (re.compile(r"\b(?:AC|DC)\s*\d+\b"), ""),
]


def scrub_dice(text):
    """Remove dice/combat numbers the recap must not contain; gold and item counts are kept."""
    for pattern, repl in _DICE:
        text = pattern.sub(repl, text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"[ \t]+([,.;:)])", r"\1", text)
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r"\band\s+(,|\.)", r"\1", text)
    return text


NO_STORY = "NO_STORY"


def is_no_story(notes_text):
    """True when chunk notes hold nothing but "(no story events)" markers."""
    lines = [l.strip(" -*\t") for l in notes_text.splitlines() if l.strip(" -*\t")]
    return all("no story events" in l.lower() for l in lines)


def previously(text):
    """Last session's recap as background: spellings and open threads, not events of this session."""
    if not text:
        return ""
    return f"""
Background, the recap of the PREVIOUS session (for name spellings and continuing open threads only; do NOT retell it and do NOT present anything from it as happening in this session):
<<<
{text.strip()[:3000]}
>>>
"""


def final_recap(meta, notes, vocab):
    # The world/campaign title is deliberately NOT given to the model: a title like
    # "Cursed Dragon of Phandelver" made Mistral fill the recap with the published
    # adventure (Cragmaw Hideout, goblins) instead of what was actually said.
    minutes = int(meta.get("duration_seconds", 0) / 60)
    speakers = ", ".join(meta.get("speakers", [])) or "unknown"
    prompt = f"""You are writing a recap of a recorded tabletop RPG session, for the players to read.

Length: {minutes} minutes
Speakers: {speakers}

{previously(meta.get("previous_recap"))}
{GROUNDING}{vocab_rule(vocab)}
- Every name, place, creature and item you mention MUST appear in the notes below. Do not use anything you know about published adventures or settings.
- Leave out dice and game-mechanic numbers: attack rolls, damage, hit points, armor class, ability checks, saving throws. Describe what happened instead ("landed a critical hit", "the enemy fell"). Amounts of gold or items gained are fine.
- If the notes contain no story events (only microphone checks, setup or table talk), reply with exactly {NO_STORY} and nothing else.

Chronological notes from the session:
{notes}

Write the recap in Markdown. Use only the sections below that the notes actually support, in this order. If a section would be empty, leave out its heading too; never write that nothing happened in a section. Nothing before the first heading.

## Summary
One or two short paragraphs telling what happened, in past tense, third person, using character names.

## Key Events
- Bulleted, chronological.

## People & Places
- NPCs and locations named in the notes, one line each.

## Loot & Rewards
- Items, money, experience or favors gained or lost.

## Open Threads
- Unresolved questions, promises, and where the party stopped. An open thread from the previous session may be repeated only if it is still unresolved in these notes."""
    return ollama(prompt, 1600)


@app.route("/chunk-notes", methods=["POST"])
def chunk_notes_route():
    body = request.get_json(silent=True) or {}
    chunk = body.get("chunk") or {}
    if not str(chunk.get("transcript", "")).strip():
        return jsonify({"status": "success", "notes": "- (no story events)"})
    vocab = parse_vocab("\n".join(body.get("vocab") or []))
    logger.info(f"Notes for '{body.get('session_name', 'Session')}' chunk {chunk.get('index')} ({approx_tokens(chunk['transcript'])} tokens)")
    return jsonify({"status": "success", "notes": chunk_notes(body.get("session_name", "Session"), chunk, vocab)})


@app.route("/summarize", methods=["POST"])
def summarize():
    meta = request.get_json(silent=True) or {}
    chunks = [c for c in meta.get("chunks", []) if str(c.get("transcript", "")).strip() or c.get("notes")]
    if not chunks:
        return jsonify({"status": "error", "error": "No transcript text to summarize"}), 400
    name = meta.get("session_name", "Session")
    vocab = parse_vocab("\n".join(meta.get("vocab") or []))
    logger.info(f"Summarizing '{name}': {len(chunks)} chunks")

    notes = []
    for c in chunks:
        if c.get("notes"):
            chunk_text = c["notes"]
        else:
            logger.info(f"  notes for chunk {c.get('index')} ({approx_tokens(c['transcript'])} tokens)")
            chunk_text = chunk_notes(name, c, vocab)
        notes.append(f"[{c.get('start', '?')}]\n{chunk_text}")

    # Condense in groups until the notes fit comfortably in one final prompt.
    notes_budget = max(OLLAMA_NUM_CTX - 2500, 1500)
    while approx_tokens("\n\n".join(notes)) > notes_budget and len(notes) > 1:
        logger.info(f"  condensing {len(notes)} note sets")
        notes = [condense(name, "\n\n".join(notes[i:i + 4])) for i in range(0, len(notes), 4)]

    model = {"whisper": WHISPER_MODEL, "ollama": OLLAMA_MODEL}
    if all(is_no_story(n.split("\n", 1)[-1]) for n in notes):
        logger.info("  every chunk is '(no story events)'; skipping final recap")
        return jsonify({"status": "success", "summary": NO_STORY, "model": model})

    recap = final_recap(meta, fit(scrub_dice("\n\n".join(notes)), notes_budget), vocab)
    if NO_STORY in recap[:40]:
        recap = NO_STORY
    # Models sometimes open with a sentence before the first heading; drop it.
    first = recap.find("## ")
    if first > 0:
        recap = recap[first:]
    recap = re.sub(r"\n{3,}", "\n\n", scrub_dice(recap)).strip()
    logger.info(f"Recap done ({len(recap)} chars)")
    return jsonify({"status": "success", "summary": recap, "model": model})


if __name__ == "__main__":
    server = WSGIServer((BIND, PORT), app, numthreads=4)
    server.ssl_adapter = BuiltinSSLAdapter(TLS_CERT, TLS_KEY)
    logger.info(f"Scrit Cribbler backend on https://{BIND}:{PORT} (faster-whisper={WHISPER_MODEL}/{WHISPER_COMPUTE}, "
                f"ollama={OLLAMA_MODEL}, num_ctx={OLLAMA_NUM_CTX})")
    try:
        server.start()
    except KeyboardInterrupt:
        server.stop()
