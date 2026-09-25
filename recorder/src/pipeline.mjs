import fs from "node:fs";
import path from "node:path";
import { Agent, fetch, FormData } from "undici";
import { config } from "./config.mjs";
import { slug } from "./recorder.mjs";
import { localDate } from "./sessions.mjs";
import { MIN_STORY_WORDS, groundByVocab, isUnverified, notesAreEmpty, stripEmptySections, ungroundedTerms, wordCount } from "./grounding.mjs";

const MIN_VOICED_SECONDS = 1.5;
const RETRY_DELAYS_S = [30, 60, 120, 300, 300, 300, 300, 300, 300, 300, 300, 300]; // ~1 h total

// Long timeouts: Whisper on a 10 min file or a multi-pass summary can take many minutes.
const dispatcher = new Agent({
  headersTimeout: 60 * 60 * 1000,
  bodyTimeout: 60 * 60 * 1000,
  connect: config.backendCa ? { ca: fs.readFileSync(config.backendCa) } : {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backend(pathname, init) {
  const res = await fetch(`${config.backendUrl}${pathname}`, {
    ...init,
    dispatcher,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${config.backendToken}` }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== "success") throw new Error(body.error || `backend HTTP ${res.status}`);
  return body;
}

async function withRetry(session, what, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= RETRY_DELAYS_S.length) throw e;
      session.addLog(`${what} failed (${e.message}); retry ${attempt + 1} in ${RETRY_DELAYS_S[attempt]} s`);
      await sleep(RETRY_DELAYS_S[attempt] * 1000);
    }
  }
}

const hms = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

/** What happened during processing: for debugging recaps from the journal instead of logs. */
export function processingReport(session) {
  const d = session.data;
  return {
    models: { whisper: d.chunks.find((c) => c.report?.whisperModel)?.report.whisperModel ?? d.model?.whisper ?? null, ollama: d.model?.ollama ?? null },
    recapStatus: d.recapStatus ?? null,
    stopToRecapSec: d.processingSec ?? null,
    summarizeSec: d.summarizeSec ?? null,
    previousRecapFrom: d.previousRecapFrom ?? null,
    vocab: d.vocab ?? [],
    chunks: d.chunks.map((c) => ({
      index: c.index,
      status: c.status,
      speakers: c.report?.speakers ?? null,
      transcribeSec: c.report?.transcribeSec ?? null,
      notesSec: c.report?.notesSec ?? null,
      dropped: c.report?.dropped ?? {},
      crosstalk: c.report?.crosstalk ?? []
    }))
  };
}

function readNotes(session, index) {
  const file = path.join(session.dir, `chunk-${String(index).padStart(3, "0")}`, "notes.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() || undefined : undefined;
}

const CROSSTALK_WINDOW_S = 2.0;   // other speaker's words must be this close in time
const CROSSTALK_COVERAGE = 0.8;    // share of a line's words also said by the other speaker
const CROSSTALK_QUIETER_DB = 6;    // bleed on a mic is much quieter than the speaker's own mic (~10 dB in tests)

const tokens = (t) => String(t).toLowerCase().match(/[a-z0-9']+/g) || [];

/**
 * A player on speakers (no headphones) puts other voices into their own mic, so one line
 * shows up on two tracks. Whisper splits it differently on each track, so lines are not
 * compared one-to-one: a line is bleed when most of its words were said at the same time
 * by another speaker whose copy is clearly louder. A player's real speech is loud on their
 * own mic, so it never passes the loudness test even when the words overlap.
 */
export function removeCrosstalk(segments) {
  const report = [];
  const kept = segments.filter((seg) => {
    const own = tokens(seg.text);
    if (!own.length || seg.level == null) return true;
    const others = segments.filter((o) => o.speaker !== seg.speaker && o.level != null
      && o.start <= seg.end + CROSSTALK_WINDOW_S && o.end >= seg.start - CROSSTALK_WINDOW_S);
    if (!others.length) return true;
    const bag = new Map();
    for (const w of others.flatMap((o) => tokens(o.text))) bag.set(w, (bag.get(w) || 0) + 1);
    let covered = 0;
    for (const w of own) if (bag.get(w) > 0) { covered++; bag.set(w, bag.get(w) - 1); }
    const loudest = others.reduce((a, b) => (b.level > a.level ? b : a));
    const isBleed = covered / own.length >= CROSSTALK_COVERAGE && loudest.level - seg.level >= CROSSTALK_QUIETER_DB;
    if (isBleed) report.push({ t: hms(seg.start), removedFrom: seg.speaker, keptFor: loudest.speaker, text: seg.text, levels: [seg.level, loudest.level] });
    return !isBleed;
  });
  return { segments: kept, removed: report };
}

/** Serial job queue: the desktop has one GPU, so chunks and summaries run one at a time. */
export class Pipeline {
  /** @param {{previousRecap?: (session) => string|null}} hooks */
  constructor(hooks = {}) {
    this.tail = Promise.resolve();
    this.previousRecap = hooks.previousRecap ?? (() => null);
  }

  enqueue(label, fn) {
    this.tail = this.tail.then(fn).catch((e) => console.error(`pipeline task ${label} failed:`, e));
    return this.tail;
  }

  chunk(session, index) {
    return this.enqueue(`${session.id}#${index}`, () => this.transcribeChunk(session, index));
  }

  finish(session) {
    return this.enqueue(`${session.id}#finish`, () => this.summarize(session));
  }

  async transcribeChunk(session, index) {
    const entry = session.data.chunks[index];
    if (!entry || entry.status !== "recorded") return;
    const dir = path.join(session.dir, `chunk-${String(index).padStart(3, "0")}`);
    let segments = [];
    const report = { speakers: 0, dropped: {}, transcribeSec: 0, notesSec: null, crosstalk: [] };
    const t0 = Date.now();
    try {
      for (const sp of entry.speakers || []) {
        if (sp.voicedSeconds < MIN_VOICED_SECONDS) continue;
        const label = session.label(sp.identity);
        const res = await withRetry(session, `transcribe chunk ${index} / ${label}`, async () => {
          const form = new FormData();
          const buf = fs.readFileSync(path.join(dir, sp.file));
          form.append("audio", new Blob([buf], { type: "audio/ogg" }), sp.file);
          form.append("speaker", label);
          if (session.data.vocab?.length) form.append("vocab", session.data.vocab.join("\n"));
          return backend("/transcribe-chunk", { method: "POST", body: form });
        });
        report.speakers++;
        report.whisperModel = res.model ?? report.whisperModel;
        for (const [k, v] of Object.entries(res.dropped || {})) report.dropped[k] = (report.dropped[k] || 0) + v;
        for (const seg of res.segments || []) {
          const text = String(seg.text || "").trim();
          if (text) segments.push({ speaker: label, start: entry.startSec + seg.start, end: entry.startSec + seg.end, text, level: seg.level });
        }
      }
      segments.sort((a, b) => a.start - b.start);
      const deduped = removeCrosstalk(segments);
      segments = deduped.segments;
      report.crosstalk = deduped.removed;
      report.transcribeSec = Math.round((Date.now() - t0) / 1000);
      entry.report = report;
      fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify(segments, null, 2));
      entry.status = "transcribed";
      session.addLog(`chunk ${index} transcribed (${segments.length} segments${report.crosstalk.length ? `, ${report.crosstalk.length} crosstalk duplicates removed` : ""})`);
    } catch (e) {
      entry.status = "error";
      entry.error = e.message;
      session.addLog(`chunk ${index} transcription gave up: ${e.message}`);
      session.save();
      return;
    }
    session.save();
    await this.chunkNotes(session, index, dir, segments);
  }

  /**
   * Story notes for one chunk, made during the session so only the final merge is left
   * after Stop. Best effort: if this fails, /summarize makes the notes itself.
   */
  async chunkNotes(session, index, dir, segments) {
    const entry = session.data.chunks[index];
    const notesFile = path.join(dir, "notes.md");
    fs.rmSync(notesFile, { force: true });
    if (!segments.length) return;
    const t0 = Date.now();
    try {
      const res = await backend("/chunk-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_name: session.data.sessionName,
          vocab: session.data.vocab ?? [],
          chunk: { index, start: hms(entry.startSec), transcript: segments.map((g) => `[${hms(g.start)}] ${g.speaker}: ${g.text}`).join("\n") }
        })
      });
      fs.writeFileSync(notesFile, String(res.notes || "").trim());
      if (entry.report) entry.report.notesSec = Math.round((Date.now() - t0) / 1000);
      session.addLog(`chunk ${index} notes ready`);
    } catch (e) {
      session.addLog(`chunk ${index} notes skipped (${e.message}); will be made at the end`);
    }
  }

  /** Transcript lines for the whole session, consecutive lines from one speaker merged. */
  transcript(session) {
    const lines = [];
    for (const c of session.data.chunks) {
      const file = path.join(session.dir, `chunk-${String(c.index).padStart(3, "0")}`, "transcript.json");
      if (c.status !== "transcribed" || !fs.existsSync(file)) {
        if (c.status === "error") lines.push({ t: hms(c.startSec), start: c.startSec, speaker: null, text: `[chunk ${c.index} missing: ${c.error || "error"}]` });
        continue;
      }
      for (const seg of JSON.parse(fs.readFileSync(file, "utf8"))) {
        const prev = lines.at(-1);
        if (prev && prev.speaker === seg.speaker && seg.start - prev.end < 3) {
          prev.text += ` ${seg.text}`;
          prev.end = seg.end;
        } else {
          lines.push({ t: hms(seg.start), start: seg.start, end: seg.end, speaker: seg.speaker, text: seg.text });
        }
      }
    }
    return lines.map(({ t, start, speaker, text }) => ({ t, start, speaker, text }));
  }

  /**
   * Decide what the recap is:
   *   ok          LLM recap, every asserted name found in the transcript/notes
   *   no-story    too little speech, or nothing but "(no story events)"; no LLM text used
   *   unverified  LLM recap names things never said; withheld from players (GM sees it)
   */
  async summarize(session) {
    const d = session.data;
    try {
      const lines = this.transcript(session);
      const spoken = lines.filter((l) => l.speaker);
      d.spokenSpeakers = [...new Set(spoken.map((l) => l.speaker))];
      if (!spoken.length) throw new Error("No speech was transcribed. Check the recorder log and that players were in the A/V room.");

      const chunks = d.chunks.map((c) => ({
        index: c.index,
        start: hms(c.startSec),
        notes: readNotes(session, c.index),
        transcript: spoken
          .filter((l) => l.start >= c.startSec && (!d.chunks[c.index + 1] || l.start < d.chunks[c.index + 1].startSec))
          .map((l) => `[${l.t}] ${l.speaker}: ${l.text}`)
          .join("\n")
      })).filter((c) => c.transcript);
      d.notes = chunks.filter((c) => c.notes).map((c) => `### ${c.start}\n\n${c.notes}`).join("\n\n") || null;

      Object.assign(d, { summary: null, model: null, recapStatus: null, recapNote: null, unverifiedTerms: [] });
      const words = wordCount(spoken);
      const allNotes = chunks.map((c) => c.notes);
      if (words < MIN_STORY_WORDS) {
        d.recapStatus = "no-story";
        d.recapNote = `Only ${words} words were transcribed (minimum ${MIN_STORY_WORDS} for a recap).`;
      } else if (allNotes.every(Boolean) && notesAreEmpty(allNotes)) {
        d.recapStatus = "no-story";
        d.recapNote = "The chunk notes found no story events.";
      } else {
        const previous = d.usePreviousRecap === false ? null : this.previousRecap(session);
        d.previousRecapFrom = previous?.from ?? null;
        const t0 = Date.now();
        const res = await withRetry(session, "summarize", () =>
          backend("/summarize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // No world/campaign title: it primes the model to invent published-adventure content.
            body: JSON.stringify({
              session_name: d.sessionName,
              vocab: d.vocab ?? [],
              duration_seconds: session.durationSec(),
              speakers: d.spokenSpeakers,
              // Context for spellings and continuing threads only. The grounding check below
              // uses this session's transcript and notes, never the previous recap.
              previous_recap: previous?.text ?? null,
              chunks
            })
          })
        );
        d.model = res.model || null;
        d.summarizeSec = Math.round((Date.now() - t0) / 1000);
        const text = stripEmptySections(String(res.summary || "").trim());
        if (!text || text === "NO_STORY") {
          d.recapStatus = "no-story";
          d.recapNote = "The summarizer found no story events.";
        } else {
          d.summary = text;
          const source = [...spoken.map((l) => `${l.speaker} ${l.text}`), ...allNotes.filter(Boolean)].join("\n");
          const check = groundByVocab(ungroundedTerms(text, source), source, d.vocab ?? []);
          if (isUnverified(check)) {
            d.recapStatus = "unverified";
            d.unverifiedTerms = check.missing;
            d.recapNote = `The AI recap mentions ${check.missing.length} of ${check.checked} names/terms that never appear in the transcript: ${check.missing.join(", ")}.`;
          } else {
            d.recapStatus = "ok";
          }
        }
      }

      d.processingSec = d.processingStartedAt ? Math.round((Date.now() - Date.parse(d.processingStartedAt)) / 1000) : null;
      d.recapFile = this.writeRecap(session, lines);
      d.state = "done";
      d.error = null;
      session.addLog(`recap ${d.recapStatus}${d.recapNote ? ` (${d.recapNote})` : ""}; written: ${d.recapFile}`);
    } catch (e) {
      d.state = "error";
      d.error = e.message;
      session.addLog(`processing failed: ${e.message}`);
    }
    session.save();
  }

  writeRecap(session, lines) {
    const d = session.data;
    fs.mkdirSync(config.recapsDir, { recursive: true });
    const date = localDate(new Date(d.startedAt));
    const file = path.join(config.recapsDir, `${slug(d.world)}-${date}-${slug(d.sessionName)}.md`);
    const md = [
      `# ${d.sessionName}`,
      "",
      `- **World:** ${d.worldTitle}`,
      `- **Date:** ${new Date(d.startedAt).toLocaleString("en-US")}`,
      `- **Duration:** ${Math.round(session.durationSec() / 60)} min`,
      `- **Speakers:** ${d.spokenSpeakers.join(", ")}`,
      `- **Recap status:** ${d.recapStatus}${d.recapNote ? ` — ${d.recapNote}` : ""}`,
      `- **Recording:** \`${session.dir}\``,
      "",
      d.recapStatus === "ok" ? d.summary : "*No AI recap was published for this session.*",
      "",
      ...(d.recapStatus === "unverified" ? ["## Unverified AI recap (not shown to players)", "", d.summary, ""] : []),
      ...(d.notes ? ["## Chunk notes", "", d.notes, ""] : []),
      "## Processing report", "", "```json", JSON.stringify(processingReport(session), null, 2), "```", "",
      "---",
      "",
      "## Transcript",
      "",
      ...lines.map((l) => (l.speaker ? `**[${l.t}] ${l.speaker}:** ${l.text}  ` : `*[${l.t}] ${l.text}*  `))
    ].join("\n");
    fs.writeFileSync(file, md);
    return file;
  }
}
