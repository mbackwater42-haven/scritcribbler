// Pure helpers for the "Ask the campaign KB" dialog. No Foundry globals here, so they can be unit tested
// in Node (tests/test_kb_dialog.mjs). The answer comes from a language model reading the GM's notes, so
// nothing from the server is ever put into the page as HTML except through escapeHtml().

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Plain-text model answer -> safe HTML: escape everything first, then add only our own markup
 * (citation badges for "[2]" / "[1, 3]" and line breaks).
 */
export function answerHtml(answer) {
  return escapeHtml(answer)
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, '<span class="sc-cite">[$1]</span>')
    .replace(/\r?\n/g, "<br>");
}

export const AUDIENCE_LABELS = {
  gm: "GM view (everything)",
  players: "Players view (only what the players know)"
};

/** Source list from the server -> template rows. Text fields stay plain; the template escapes them. */
export function viewSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((s) => ({
    n: s.n,
    label: `${s.file} › ${s.heading}`,
    reliability: s.reliability ?? "",
    cited: !!s.cited,
    text: String(s.text ?? "").slice(0, 700)
  }));
}

/** Friendly text for the status codes the recorder route can return (see recorder/src/kbproxy.mjs). */
export function errorMessage(status, serverMessage) {
  const msg = String(serverMessage ?? "").trim();
  switch (status) {
    case 401: return "Not authorised. Check the Recorder token in Configure Settings → Scrit Cribbler, and that you are logged in as the Gamemaster.";
    case 403: return "Only the Gamemaster can ask the campaign KB.";
    case 404: return "No campaign knowledge base is set up for this world.";
    case 413: return "That question is too long.";
    case 429: return msg || "Too many questions. Wait a moment and try again.";
    case 502: return "The knowledge base is unavailable. Is the workstation backend running?";
    case 503: return msg || "The model is busy (a recap may be running). Try again in a minute.";
    default: return status ? msg || `The server returned HTTP ${status}.` : `Could not reach the recorder${msg ? `: ${msg}` : "."}`;
  }
}

/** One finished question as shown in the history list. */
export function historyEntry({ question, audience, response, now = new Date() }) {
  return {
    question,
    audienceLabel: AUDIENCE_LABELS[audience] ?? audience,
    answerHtml: answerHtml(response.answer ?? ""),
    sources: viewSources(response.sources),
    meta: `${response.model ?? "model"} · ${response.seconds ?? "?"} s · ${now.toLocaleTimeString()}`
  };
}
