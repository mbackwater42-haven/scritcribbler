/**
 * Safety net for LLM recaps: a small local model will fill a recap template from what
 * it knows about published adventures when the session had little or no story. These
 * checks run on the server and decide whether the recap is shown to players.
 */

export const MIN_STORY_WORDS = 150;

const STOP = new Set(`the a an and or but of in on at to for from with by as is was were be been are it its this that
these those he she they them their his her we our you your i me my not no yes into onto over under after before
during while then than there here when where who what which how all any some each every more most other such only
own same so too very can will just also party session game master player players gm dm npc npcs enemies enemy
location locations item items gold summary events people places loot rewards threads open key none unknown`.split(/\s+/));

const words = (text) => (String(text).toLowerCase().match(/[a-z][a-z'’-]*/g) || []).map((w) => w.replace(/['’]s$/, ""));

function inVocab(word, vocab) {
  const w = word.toLowerCase().replace(/['’]s$/, "");
  return vocab.has(w) || vocab.has(w.replace(/(es|s)$/, "")) || vocab.has(`${w}s`);
}

export const wordCount = (lines) => lines.reduce((n, l) => n + words(l.text).length, 0);

/** Chunk notes that contain nothing but "(no story events)" markers. */
export function notesAreEmpty(notes) {
  const lines = notes.flatMap((n) => String(n || "").split("\n")).map((l) => l.replace(/^[\s\-*]+/, "").trim()).filter(Boolean);
  return lines.length === 0 || lines.every((l) => /no story events/i.test(l));
}

/**
 * Names and nouns the recap asserts that never occur in the transcript or notes.
 * Candidates: capitalized words that are not at the start of a sentence or bullet
 * (proper nouns), plus the words of each People & Places / Loot entry.
 */
export function ungroundedTerms(recap, sourceText) {
  const vocab = new Set(words(sourceText));
  const candidates = new Set();
  let section = "";
  for (const raw of String(recap).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      section = line.replace(/^#+\s*/, "").toLowerCase();
      continue;
    }
    const body = line.replace(/^[-*]\s+/, "");
    // Proper nouns: capitalized words not directly after a sentence boundary.
    const tokens = body.split(/\s+/);
    tokens.forEach((tok, i) => {
      const clean = tok.replace(/^[^A-Za-z]+|[^A-Za-z'’]+$/g, "");
      if (!/^[A-Z][a-z]{2,}/.test(clean)) return;
      const prev = i === 0 ? "" : tokens[i - 1];
      if (i === 0 || /[.!?:]["')]?$/.test(prev)) return;
      candidates.add(clean);
    });
    // Entries in list sections name concrete things; every word must be sourced.
    if (/^[-*]\s+/.test(line) && /(people|places|loot|rewards)/.test(section)) {
      const entry = body.split(/[(:—–]| - /)[0];
      for (const w of words(entry)) if (w.length >= 4) candidates.add(w);
    }
  }
  const terms = [...candidates].filter((t) => !STOP.has(t.toLowerCase()));
  const missing = [...new Set(terms.filter((t) => !inVocab(t, vocab)).map((t) => t.toLowerCase()))];
  return { checked: terms.length, missing };
}

/** Unverified when at least 2 asserted terms, and 30% or more of them, are not in the source. */
export function isUnverified({ checked, missing }) {
  return missing.length >= 2 && missing.length / Math.max(checked, 1) >= 0.3;
}
