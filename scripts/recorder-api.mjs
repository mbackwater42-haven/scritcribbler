export const MODULE_NAME = "scrit-cribbler";

const POLL_MS = 30000;
const posting = new Set();

/** Call the scrit-recorder service on the Foundry server (proxied by nginx at /scrit). */
export async function api(path, { method = "GET", body } = {}) {
  const token = game.settings.get(MODULE_NAME, "recorder-token");
  if (!token) throw new Error("Recorder token is not set (Configure Settings → Scrit Cribbler).");
  const base = game.settings.get(MODULE_NAME, "recorder-url").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Recorder returned HTTP ${res.status}`), { status: res.status });
  return data;
}

/**
 * GM lore Q&A through the recorder's /kb/ask. The recorder checks that this browser is logged in to Foundry
 * as the Gamemaster (the session cookie travels with the request) and that the recorder token is right.
 * audience: "gm" (everything) or "players" (only what the players know).
 */
export async function askKb(question, audience = "gm") {
  return api("/kb/ask", { method: "POST", body: { world: game.world.id, question, audience } });
}

/** LiveKit room the A/V client is using (avclient-livekit sets client.room). */
export function currentRoom() {
  return game.webrtc?.client?.room ?? game.webrtc?.settings?.world?.server?.room ?? null;
}

/** Foundry user id -> display info, so the recorder can label speakers "Character (Player)". */
export function roster() {
  const out = {};
  for (const u of game.users) {
    out[u.id] = { name: u.name, character: u.character?.name ?? null, isGM: u.isGM };
  }
  return out;
}

/**
 * Campaign names that speech recognition would otherwise mis-hear ("Talon" -> "talent",
 * "Knight" -> "night"). Whisper gets these as hotwords, and a long list backfires: in
 * quiet stretches it "hears" the list itself ("Dagger, Dagger of Fire Resistance...").
 * So only unusual names, most important first, capped: player characters, the scene(s)
 * in view, then rare or oddly named items and spells. Plain-English names ("Potion of
 * Speed", "Longsword +1", every cleric spell) are left out; Whisper spells those fine.
 */
const VOCAB_MAX = { scene: 15, items: 10, total: 40 };
const DISTINCT_RARITY = new Set(["rare", "veryrare", "legendary", "artifact"]);

/** "Shield (Legacy)" -> "Shield", "Dagger, +1" / "Longsword +1" -> base name. */
function plainName(name) {
  return String(name ?? "").replace(/\s*\(legacy\)\s*$/i, "").replace(/,?\s*\+\d+\s*$/, "").replace(/\s+/g, " ").trim();
}

export function campaignVocab() {
  const terms = [];
  const seen = new Set();
  const add = (name) => {
    const n = plainName(name);
    if (n.length < 3 || n.length > 40 || seen.has(n.toLowerCase())) return false;
    seen.add(n.toLowerCase());
    terms.push(n);
    return true;
  };
  const characters = game.users.filter((u) => !u.isGM && u.character).map((u) => u.character);
  for (const actor of characters) {
    // 'Zeal "Hat Trick" Paris (Zee)' -> "Zeal Paris", "Zeal", "Hat Trick", "Zee"
    const nicknames = [...actor.name.matchAll(/"([^"]+)"|\(([^)]+)\)/g)].map((m) => m[1] ?? m[2]);
    const full = actor.name.replace(/"[^"]*"|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    add(full);
    add(full.split(" ")[0]);
    nicknames.forEach(add);
  }

  // Tokens on the scene(s) in view: NPCs and monsters the table is about to name.
  // "Goblin 3" -> "Goblin"; player characters are already in.
  let sceneTerms = 0;
  for (const scene of new Set([game.scenes.viewed, game.scenes.active].filter(Boolean))) {
    if (sceneTerms < VOCAB_MAX.scene && add(scene.navName || scene.name)) sceneTerms++;
    for (const token of scene.tokens) {
      if (sceneTerms >= VOCAB_MAX.scene) break;
      if (token.actor?.type === "character") continue;
      if (add(token.name.replace(/\s*\d+$/, ""))) sceneTerms++;
    }
  }

  // Named things only: rare+ gear (not potions or scrolls), or an apostrophe ("Aganazzar's Shocker", "Zee's Jester's Mask").
  let itemTerms = 0;
  for (const actor of characters) {
    for (const item of actor.items) {
      if (itemTerms >= VOCAB_MAX.items) break;
      const rarity = String(item.system?.rarity ?? "").toLowerCase().replace(/\s/g, "");
      const named = /['’]/.test(item.name);
      const wanted = ["spell", "consumable"].includes(item.type) ? named : item.type !== "feat" && (named || DISTINCT_RARITY.has(rarity));
      if (wanted && add(item.name)) itemTerms++;
    }
  }
  return terms.slice(0, VOCAB_MAX.total);
}

const STORY_MAX_CHARS = 4000;

/**
 * Plain text of the GM's story-so-far journal, or null if it does not exist or is empty.
 * DOMParser does not run scripts or load images, unlike innerHTML.
 */
export function storySoFar() {
  // "Story So Far" also matches "The Story So Far" (and case differences).
  const bare = (n) => String(n ?? "").trim().toLowerCase().replace(/^the\s+/, "");
  const wanted = bare(game.settings.get(MODULE_NAME, "story-journal"));
  const entry = wanted ? game.journal.find((j) => bare(j.name) === wanted) : null;
  if (!entry) return null;
  const text = entry.pages.contents
    .filter((p) => p.type === "text")
    .sort((a, b) => a.sort - b.sort)
    .map((p) => `${p.name}\n${new DOMParser().parseFromString(p.text?.content ?? "", "text/html").body.textContent}`)
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text.slice(0, STORY_MAX_CHARS) : null;
}

/** While recording, send the names from each newly viewed scene (GM changed scenes mid-session). */
export function trackSceneVocab() {
  Hooks.on("canvasReady", async () => {
    if (game.users.activeGM !== game.user || !game.settings.get(MODULE_NAME, "recorder-token")) return;
    try {
      const { active } = await api(`/sessions?world=${encodeURIComponent(game.world.id)}`);
      if (active) await api(`/sessions/${active}/vocab`, { method: "POST", body: { vocab: campaignVocab() } });
    } catch (e) {
      console.warn("Scrit Cribbler | vocab update failed:", e.message);
    }
  });
}

/**
 * Background job on the active GM's client: any finished recap for this world that
 * is not yet in the journal gets posted. Runs on login too, so a recap that finished
 * while no GM was online is posted the next time one logs in.
 */
export function startRecapPoller() {
  const tick = async () => {
    if (game.users.activeGM !== game.user) return;
    if (!game.settings.get(MODULE_NAME, "recorder-token")) return;
    try {
      const { sessions } = await api(`/sessions?world=${encodeURIComponent(game.world.id)}`);
      for (const s of sessions) {
        if (s.state === "done" && !s.posted) await postRecap(s.id);
      }
    } catch (e) {
      console.warn("Scrit Cribbler | recap poll failed:", e.message);
    }
  };
  tick();
  setInterval(tick, POLL_MS);
}

export async function postRecap(sessionId) {
  if (posting.has(sessionId)) return;
  posting.add(sessionId);
  try {
    const result = await api(`/sessions/${sessionId}/result`);
    const page = await writeJournal(result);
    await api(`/sessions/${sessionId}/posted`, { method: "POST" });
    const link = `@UUID[${page.uuid}]{${foundry.utils.escapeHTML(page.name)}}`;
    const status = {
      ok: `<p><strong>Session recap ready:</strong> ${link}</p>`,
      "no-story": `<p><strong>Session recorded, no story recap:</strong> ${link}</p><p><em>${esc(result.recapNote)}</em></p>`,
      unverified: `<p><strong>AI recap withheld from players:</strong> ${link}</p><p><em>${esc(result.recapNote)}</em> Review it on the GM-only transcript page.</p>`
    }[result.recapStatus] ?? `<p>Session recap: ${link}</p>`;
    await ChatMessage.create({
      content: status,
      whisper: ChatMessage.getWhisperRecipients("GM"),
      style: CONST.CHAT_MESSAGE_STYLES.OOC,
      speaker: { alias: "Scrit Cribbler" }
    });
    ui.notifications.info(`Scrit Cribbler | Recap posted: ${page.name}`);
  } catch (e) {
    console.error("Scrit Cribbler | posting recap failed:", e);
    ui.notifications.error(`Scrit Cribbler | Could not post recap: ${e.message}`);
  } finally {
    posting.delete(sessionId);
  }
}

// ------------------------------------------------------------------ journal

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** LLM markdown -> HTML. Raw HTML in the model output is escaped, not rendered. */
function markdownToHtml(md) {
  const safe = String(md || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const converter = new window.showdown.Converter({ simpleLineBreaks: false, noHeaderId: true });
  return converter.makeHtml(safe);
}

/** Transcript as readable paragraphs, with a heading every 10 minutes for skimming. */
function transcriptHtml(lines) {
  const out = [];
  let lastBlock = null;
  for (const l of lines) {
    const block = `${l.t.slice(0, 4)}0`; // "HH:MM:SS" -> "HH:M0"
    if (block !== lastBlock) {
      out.push(`<h3>${esc(block)}</h3>`);
      lastBlock = block;
    }
    out.push(l.speaker
      ? `<p><strong>${esc(l.speaker)}</strong> <em>${esc(l.t)}</em><br>${esc(l.text)}</p>`
      : `<p><em>${esc(l.t)} — ${esc(l.text)}</em></p>`);
  }
  return out.join("\n");
}

const DATE_IN_NAME = /\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}/;

/** Page contents per recap status. Players only ever see LLM text that passed the grounding check. */
function recapPages(result) {
  const notes = result.notes ? `<h2>Session notes</h2>\n${markdownToHtml(result.notes)}` : "";
  switch (result.recapStatus) {
    case "no-story":
      return {
        recap: `<p>No story content was recorded in this session.</p><p><em>${esc(result.recapNote)}</em></p>`,
        gmHeader: notes
      };
    case "unverified":
      return {
        recap: `<p><strong>The AI recap was withheld</strong> because it mentioned things that were never said in the session. The notes below were taken from the transcript.</p>\n${notes}`,
        gmHeader: `<h2>Unverified AI recap (hidden from players)</h2>\n<p><em>${esc(result.recapNote)}</em></p>\n${markdownToHtml(result.summary)}\n<hr>`
      };
    default:
      return { recap: markdownToHtml(result.summary), gmHeader: "" };
  }
}

/** GM-only processing report: what was sent, how long it took, what the filters removed. */
function reportHtml(report) {
  if (!report) return "";
  const secs = (n) => (n == null ? "–" : n >= 90 ? `${Math.round(n / 60)} min` : `${n} s`);
  const rows = report.chunks.map((c) => {
    const dropped = Object.entries(c.dropped || {}).filter(([, n]) => n).map(([k, n]) => `${esc(k)} ${n}`).join(", ") || "none";
    const cross = (c.crosstalk || []).map((x) =>
      `<li><em>${esc(x.t)}</em> removed from ${esc(x.removedFrom)} (kept for ${esc(x.keptFor)}${x.reason ? `; ${esc(x.reason)}` : ""}): “${esc(x.text)}”</li>`).join("");
    return `<tr><td>${c.index}</td><td>${esc(c.status)}</td><td>${c.speakers ?? "–"}</td><td>${secs(c.transcribeSec)}</td><td>${secs(c.notesSec)}</td><td>${dropped}</td><td>${(c.crosstalk || []).length}</td></tr>`
      + (cross ? `<tr><td></td><td colspan="6"><ul>${cross}</ul></td></tr>` : "");
  }).join("");
  return `<h2>Processing report</h2>
<p><strong>Models:</strong> Whisper ${esc(report.models?.whisper ?? "?")}, summary ${esc(report.models?.ollama ?? "?")} · <strong>Stop → recap:</strong> ${secs(report.stopToRecapSec)} (summary ${secs(report.summarizeSec)}) · <strong>Status:</strong> ${esc(report.recapStatus ?? "?")}</p>
<p><strong>Background context:</strong> ${esc(report.previousRecapFrom ?? "none")}</p>
<p><strong>Vocabulary (${report.vocab.length}):</strong> ${esc(report.vocab.join(", ") || "none")}</p>
<table><thead><tr><th>Chunk</th><th>Status</th><th>Speakers</th><th>Transcribe</th><th>Notes</th><th>Filtered lines</th><th>Crosstalk</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function writeJournal(result) {
  const journalName = game.settings.get(MODULE_NAME, "journal-name") || "Session Recaps";
  let entry = game.journal.getName(journalName);
  if (!entry) {
    entry = await JournalEntry.create({
      name: journalName,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
    });
  }

  const started = new Date(result.startedAt);
  const dateStr = started.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const minutes = Math.round(result.durationSec / 60);
  const baseName = DATE_IN_NAME.test(result.sessionName) ? result.sessionName : `${result.sessionName} — ${dateStr}`;
  const lastSort = Math.max(0, ...entry.pages.map((p) => p.sort));
  const speakers = result.spokenSpeakers?.length ? result.spokenSpeakers : result.speakers;
  const meta = `<p><em>${esc(started.toLocaleString())} · ${minutes} min · ${esc(speakers.join(", ") || "no speakers")}</em></p>`;
  const pages = recapPages(result);

  const [recap] = await entry.createEmbeddedDocuments("JournalEntryPage", [
    {
      name: baseName,
      type: "text",
      sort: lastSort + CONST.SORT_INTEGER_DENSITY,
      title: { show: true, level: 1 },
      text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML, content: `${meta}\n${pages.recap}` }
    },
    {
      name: `${baseName} (Transcript)`,
      type: "text",
      sort: lastSort + 2 * CONST.SORT_INTEGER_DENSITY,
      title: { show: true, level: 1 },
      // Transcript is GM-only; players see the recap page.
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML, content: `${pages.gmHeader}\n<h2>Transcript</h2>\n${transcriptHtml(result.transcript)}\n<hr>\n${reportHtml(result.report)}` }
    }
  ]);
  return recap;
}
