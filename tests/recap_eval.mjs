#!/usr/bin/env node
/**
 * Summary-model comparison for the Scrit Cribbler backend.
 *
 * Runs the real notes -> recap pipeline (/chunk-notes per 10 minutes, then /summarize)
 * on a fixed, human-corrected transcript, once per model and run, and scores each recap.
 * Uses the recorder's .env for BACKEND_URL / BACKEND_TOKEN / BACKEND_CA.
 *
 * A case is a directory (kept OUT of the repo: it holds real table talk):
 *   <case>/transcript.txt   "[hh:mm:ss] Character (Player): text" per line
 *   <case>/background.txt   story-so-far text sent as background (optional)
 *   <case>/vocab.txt        campaign names, one per line (optional)
 *   <case>/facts.txt        "label | regex" events a good recap mentions
 *   <case>/forbidden.txt    "label | regex" claims that are wrong for this session
 *
 * Scores: facts covered, forbidden claims made, names/terms not found in the transcript
 * (the recorder's grounding check), digits left in the recap, seconds.
 *
 * Usage:
 *   node tests/recap_eval.mjs --models mistral,qwen3:8b --runs 2 --out /tmp/recaps CASE_DIR
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../recorder/src/config.mjs";
import { groundByVocab, isUnverified, stripEmptySections, ungroundedTerms } from "../recorder/src/grounding.mjs";
import { Agent, fetch } from "../recorder/node_modules/undici/index.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const models = opt("models", "mistral").split(",").map((m) => m.trim()).filter(Boolean);
const runs = Number(opt("runs", "1"));
const out = opt("out", null);
const cases = args;
if (!cases.length) {
  console.error("usage: recap_eval.mjs --models a,b --runs N [--out DIR] CASE_DIR ...");
  process.exit(2);
}

const dispatcher = new Agent({
  headersTimeout: 60 * 60 * 1000,
  bodyTimeout: 60 * 60 * 1000,
  connect: config.backendCa ? { ca: fs.readFileSync(config.backendCa) } : {}
});

async function backend(pathname, body) {
  const res = await fetch(`${config.backendUrl}${pathname}`, {
    method: "POST",
    dispatcher,
    headers: { Authorization: `Bearer ${config.backendToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === "error") throw new Error(`${pathname}: ${data.error || res.status}`);
  return data;
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const rules = (file) =>
  read(file).split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => {
    const [label, re] = l.split(" | ");
    return { label: label.trim(), re: new RegExp(re.trim(), "i") };
  });
const seconds = (hms) => hms.split(":").reduce((t, n) => t * 60 + Number(n), 0);
const hms = (s) => [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");

function loadCase(dir) {
  const lines = read(path.join(dir, "transcript.txt")).split("\n")
    .map((l) => l.match(/^\[(\d+:\d+:\d+)\] ([^:]+): (.*)$/))
    .filter(Boolean)
    .map(([, t, speaker, text]) => ({ t: seconds(t), speaker, text }));
  const chunks = [];
  for (const l of lines) {
    const index = Math.floor(l.t / 600);
    (chunks[index] ??= { index, start: hms(index * 600), lines: [] }).lines.push(l);
  }
  return {
    name: path.basename(dir),
    lines,
    chunks: chunks.filter(Boolean).map((c) => ({ index: c.index, start: c.start, transcript: c.lines.map((l) => `[${hms(l.t)}] ${l.speaker}: ${l.text}`).join("\n") })),
    background: read(path.join(dir, "background.txt")).trim() || null,
    vocab: read(path.join(dir, "vocab.txt")).split("\n").map((v) => v.trim()).filter(Boolean),
    facts: rules(path.join(dir, "facts.txt")),
    forbidden: rules(path.join(dir, "forbidden.txt"))
  };
}

async function recap(c, model) {
  const t0 = Date.now();
  const chunks = [];
  for (const chunk of c.chunks) {
    const { notes } = await backend("/chunk-notes", { session_name: c.name, vocab: c.vocab, previous_recap: c.background, model, chunk });
    chunks.push({ ...chunk, notes });
  }
  const res = await backend("/summarize", {
    session_name: c.name,
    duration_seconds: c.lines.at(-1).t,
    speakers: [...new Set(c.lines.map((l) => l.speaker))],
    vocab: c.vocab,
    previous_recap: c.background,
    model,
    chunks
  });
  return { text: stripEmptySections(String(res.summary || "").trim()), notes: chunks.map((x) => x.notes), sec: Math.round((Date.now() - t0) / 1000) };
}

function score(c, r) {
  const source = [...c.lines.map((l) => `${l.speaker} ${l.text}`), ...r.notes, c.background ?? ""].join("\n");
  const grounding = groundByVocab(ungroundedTerms(r.text, source), source, c.vocab);
  return {
    facts: c.facts.filter((f) => f.re.test(r.text)).length,
    missed: c.facts.filter((f) => !f.re.test(r.text)).map((f) => f.label),
    wrong: c.forbidden.filter((f) => f.re.test(r.text)).map((f) => f.label),
    ungrounded: grounding.missing,
    unverified: isUnverified(grounding),
    digits: (r.text.match(/\d+/g) || []).length,
    words: r.text.split(/\s+/).length
  };
}

console.log(`${"case".padEnd(10)}${"model".padEnd(16)}run  facts  wrong  ungrounded  digits  words   secs`);
for (const dir of cases) {
  const c = loadCase(dir);
  for (const model of models) {
    for (let run = 1; run <= runs; run++) {
      try {
        const r = await recap(c, model);
        const s = score(c, r);
        console.log(`${c.name.padEnd(10)}${model.padEnd(16)}${String(run).padEnd(5)}${`${s.facts}/${c.facts.length}`.padEnd(7)}${String(s.wrong.length).padEnd(7)}${String(s.ungrounded.length).padEnd(12)}${String(s.digits).padEnd(8)}${String(s.words).padEnd(8)}${r.sec}`);
        if (s.wrong.length) console.log(`      wrong: ${s.wrong.join("; ")}`);
        if (s.missed.length) console.log(`      missed: ${s.missed.join("; ")}`);
        if (s.ungrounded.length) console.log(`      not in transcript: ${s.ungrounded.join(", ")}${s.unverified ? " (would be withheld)" : ""}`);
        if (out) {
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(path.join(out, `${c.name}-${model.replace(/[:/]/g, "_")}-${run}.md`),
            `${r.text}\n\n---\n## Notes\n\n${r.notes.join("\n\n")}\n\n---\n${JSON.stringify(s, null, 2)}\n`);
        }
      } catch (e) {
        console.log(`${c.name.padEnd(10)}${model.padEnd(16)}${String(run).padEnd(5)}FAILED: ${e.message}`);
      }
    }
  }
}
