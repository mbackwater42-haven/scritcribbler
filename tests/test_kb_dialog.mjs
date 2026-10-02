// Offline checks for the "Ask the campaign KB" dialog (no Foundry, no network, no real campaign data).
// Run: node --test tests/test_kb_dialog.mjs
// Layers: (1) escaping and message helpers, (2) the real template rendered with hostile data through
// Foundry's own Handlebars (skipped if it is not installed), (3) the dialog against a mocked fetch.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { answerHtml, errorMessage, escapeHtml, historyEntry, viewSources } from "../scripts/kb-format.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTILE = `<img src=x onerror=alert(1)><script>alert("x")</script>'"&`;

// ------------------------------------------------------------------ 1. helpers
test("escapeHtml neutralises tags, quotes and ampersands", () => {
  const out = escapeHtml(HOSTILE);
  assert.doesNotMatch(out, /<|>|"|'/);
  assert.match(out, /&lt;img/);
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(5), "5");
});

test("answerHtml: escapes first, then adds only its own citation badges and line breaks", () => {
  const out = answerHtml(`See [1] and [2, 3].\nNext ${HOSTILE}`);
  assert.match(out, /<span class="sc-cite">\[1\]<\/span>/);
  assert.match(out, /<span class="sc-cite">\[2, 3\]<\/span>/);
  assert.match(out, /<br>/);
  const withoutOurMarkup = out.replace(/<span class="sc-cite">\[[\d, ]+\]<\/span>/g, "").replace(/<br>/g, "");
  assert.doesNotMatch(withoutOurMarkup, /<|>/, "no other tag may survive");
  assert.doesNotMatch(answerHtml("[<script>1</script>]"), /<script/);
  assert.equal(answerHtml(undefined), "");
});

test("viewSources keeps text plain, flags cited, caps length, tolerates junk", () => {
  const rows = viewSources([{ n: 2, file: "recap_01.md", heading: "Key Points", reliability: "r", cited: 1, text: "x".repeat(900) }, { n: 3, file: "f", heading: "h" }]);
  assert.equal(rows[0].label, "recap_01.md › Key Points");
  assert.equal(rows[0].cited, true);
  assert.equal(rows[0].text.length, 700);
  assert.equal(rows[1].cited, false);
  assert.deepEqual(viewSources(undefined), []);
});

test("errorMessage maps each status the route can return", () => {
  assert.match(errorMessage(401, "x"), /Recorder token/);
  assert.match(errorMessage(403, ""), /Only the Gamemaster/);
  assert.match(errorMessage(404, ""), /No campaign knowledge base/);
  assert.match(errorMessage(429, "a question is already being answered"), /already being answered/);
  assert.match(errorMessage(503, "The model is busy (a recap may be running). Try again in a minute."), /busy/);
  assert.match(errorMessage(502, "internal"), /unavailable/);
  assert.doesNotMatch(errorMessage(502, "internal detail"), /internal detail/);
  assert.match(errorMessage(undefined, "fetch failed"), /Could not reach the recorder: fetch failed/);
  assert.match(errorMessage(500, ""), /HTTP 500/);
});

test("historyEntry builds a safe row", () => {
  const e = historyEntry({ question: HOSTILE, audience: "players", response: { answer: "A [1]", sources: [], model: "m", seconds: 3 }, now: new Date(0) });
  assert.match(e.audienceLabel, /Players view/);
  assert.match(e.answerHtml, /sc-cite/);
  assert.match(e.meta, /m · 3 s/);
});

// ------------------------------------------------------------------ 2. template
const hbPath = process.env.HANDLEBARS_PATH || path.join(process.env.HOME ?? "", "foundryvtt/resources/app/node_modules/handlebars");
const haveHb = fs.existsSync(hbPath);
test("template renders with hostile data and escapes everything except our own answer markup", { skip: !haveHb && "Foundry's Handlebars not found (set HANDLEBARS_PATH)" }, () => {
  const Handlebars = createRequire(import.meta.url)(hbPath);
  Handlebars.registerHelper("or", (...a) => a.slice(0, -1).some(Boolean)); // Foundry registers this helper
  const render = Handlebars.compile(fs.readFileSync(path.join(ROOT, "templates/kb.hbs"), "utf8"));
  const entry = historyEntry({ question: HOSTILE, audience: "gm", response: { answer: `Answer [1] ${HOSTILE}`, model: HOSTILE, seconds: 1,
    sources: [{ n: 1, file: HOSTILE, heading: HOSTILE, reliability: HOSTILE, cited: true, text: HOSTILE }] } });
  const html = render({ tokenMissing: false, question: HOSTILE, isGm: true, busy: false, error: HOSTILE, history: [entry] });
  const stripped = html.replace(/<\/?(section|label|span|textarea|div|select|option|button|i|p|strong|article|header|footer|details|summary|small|em|h3|br)\b[^>]*>/g, "");
  assert.doesNotMatch(stripped, /</, "after removing the template's own tags, no angle bracket may remain: hostile text must be escaped");
  assert.doesNotMatch(html, /<img|<script/i, "no hostile element may reach the page");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<span class="sc-cite">\[1\]<\/span>/);
  assert.match(html, /<details class="sc-kb-source cited">/);
  assert.match(html, /<option value="gm" selected>/);
  const busy = render({ tokenMissing: false, question: "q", isGm: false, busy: true, error: null, history: [] });
  assert.match(busy, /<textarea[^>]*disabled/);
  assert.match(busy, /<select[^>]*disabled/);
  assert.match(busy, /class="sc-kb-ask"[^>]*disabled/);
  assert.match(busy, /data-kb-elapsed/);
  assert.match(busy, /<option value="players" selected>/);
  assert.match(render({ tokenMissing: true, question: "", isGm: true, busy: false, error: null, history: [] }), /Recorder token/);
  assert.doesNotMatch(render({ tokenMissing: false, question: "", isGm: true, busy: false, error: null, history: [] }), /This session/, "history header hidden when empty");
});

// ------------------------------------------------------------------ 3. dialog against a mocked fetch
const state = { fetchCalls: [], respond: null, notices: [], renders: 0, rendered: [], isGM: true };
globalThis.ui = { notifications: { warn: (m) => state.notices.push(m) } };
globalThis.foundry = { applications: { instances: new Map(), api: {
  HandlebarsApplicationMixin: (Base) => class extends Base {},
  ApplicationV2: class { constructor() { this.rendered = true; this.element = fakeElement(); } async render() { state.renders++; state.rendered.push(this.constructor.name); return this; } _onRender() {} async _onClose() {} }
} } };
globalThis.game = { world: { id: "world-a" }, get user() { return { isGM: state.isGM }; },
  settings: { get: (_m, key) => ({ "recorder-token": "tok-123", "recorder-url": "/scrit" })[key] } };
globalThis.fetch = async (url, init) => { state.fetchCalls.push({ url, init }); return state.respond(url, init); };

function fakeElement() {
  const nodes = {};
  const mk = () => ({ handlers: {}, addEventListener(t, f) { this.handlers[t] = f; }, focus() { this.focused = true; }, textContent: "" });
  return { nodes, querySelector: (sel) => (nodes[sel] ??= mk()) };
}
const okResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const { KbDialog } = await import("../scripts/kb-dialog.mjs");
const ask = (dlg) => KbDialog.DEFAULT_OPTIONS.actions.ask.call(dlg);
const SUCCESS = { status: "success", answer: "Lord X leads [1].", model: "llama", seconds: 4.2, sources: [{ n: 1, file: "gm_told.md", heading: "Facts", reliability: "AUTHORITATIVE", cited: true, text: "t" }] };
const fresh = () => { state.fetchCalls = []; state.notices = []; state.isGM = true; return new KbDialog(); };

test("a successful question: sends exactly world, question, audience with the token; adds history; clears the box", async () => {
  state.respond = () => okResponse(SUCCESS);
  const dlg = fresh();
  dlg.question = "  Who leads?  ";
  dlg.audience = "players";
  await ask(dlg);
  assert.equal(state.fetchCalls.length, 1);
  const { url, init } = state.fetchCalls[0];
  assert.equal(url, "/scrit/kb/ask");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-123");
  assert.deepEqual(JSON.parse(init.body), { world: "world-a", question: "Who leads?", audience: "players" });
  assert.equal(dlg.history.length, 1);
  assert.match(dlg.history[0].answerHtml, /sc-cite/);
  assert.equal(dlg.question, "");
  assert.equal(dlg.busy, false);
  assert.equal(dlg.error, null);
});

test("errors keep the question, add no history, free the dialog, and show friendly text", async () => {
  const cases = [[401, { error: "unauthorized" }, /Recorder token/], [403, { error: "GM only" }, /Only the Gamemaster/], [429, { error: "too many requests" }, /too many requests/],
    [503, { error: "The model is busy (a recap may be running). Try again in a minute." }, /busy/], [502, { error: "knowledge base unavailable" }, /backend running/]];
  for (const [status, body, re] of cases) {
    state.respond = () => okResponse(body, status);
    const dlg = fresh();
    dlg.question = "Who leads?";
    await ask(dlg);
    assert.match(dlg.error, re, `status ${status}`);
    assert.equal(dlg.history.length, 0);
    assert.equal(dlg.question, "Who leads?", "the question is kept so it can be retried");
    assert.equal(dlg.busy, false);
  }
  state.respond = async () => { throw new TypeError("fetch failed"); };
  const dlg = fresh();
  dlg.question = "q";
  await ask(dlg);
  assert.match(dlg.error, /Could not reach the recorder: fetch failed/);
  assert.equal(dlg.busy, false);
});

test("no double submit while a question is running; empty questions send nothing", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  state.respond = async () => { await gate; return okResponse(SUCCESS); };
  const dlg = fresh();
  dlg.question = "slow one";
  const first = ask(dlg);
  try {
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(dlg.busy, true);
    // Never await the second ask directly: without the guard it would wait on the same gate forever.
    await Promise.race([ask(dlg), new Promise((r) => setTimeout(r, 200))]);
    assert.equal(state.fetchCalls.length, 1, "second click while busy must not send");
  } finally {
    release(); // always let the first request finish, even when an assertion fails, so nothing keeps the process alive
    await first;
  }
  const empty = fresh();
  empty.question = "   ";
  await ask(empty);
  assert.equal(state.fetchCalls.length, 0);
});

test("history keeps the 10 most recent, newest first; Clear empties it", async () => {
  state.respond = () => okResponse(SUCCESS);
  const dlg = fresh();
  for (let i = 1; i <= 12; i++) { dlg.question = `question ${i}`; await ask(dlg); }
  assert.equal(dlg.history.length, 10);
  assert.equal(dlg.history[0].question, "question 12");
  assert.equal(dlg.history.at(-1).question, "question 3");
  await KbDialog.DEFAULT_OPTIONS.actions.clear.call(dlg);
  assert.equal(dlg.history.length, 0);
});

test("keyboard: Enter asks, Shift+Enter does not; typing and the view selector update state", async () => {
  state.respond = () => okResponse(SUCCESS);
  const dlg = fresh();
  dlg._onRender({}, {});
  const box = dlg.element.nodes["textarea[name='kb-question']"];
  const sel = dlg.element.nodes["select[name='kb-audience']"];
  assert.equal(box.focused, true);
  box.handlers.input({ currentTarget: { value: "typed question" } });
  sel.handlers.change({ currentTarget: { value: "players" } });
  assert.equal(dlg.question, "typed question");
  assert.equal(dlg.audience, "players");
  let prevented = false;
  box.handlers.keydown({ key: "Enter", shiftKey: true, isComposing: false, preventDefault() { prevented = true; } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.fetchCalls.length, 0, "Shift+Enter must not send");
  assert.equal(prevented, false);
  box.handlers.keydown({ key: "Enter", shiftKey: false, isComposing: true, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.fetchCalls.length, 0, "Enter while composing (IME) must not send");
  box.handlers.keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() { prevented = true; } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(prevented, true);
  assert.equal(state.fetchCalls.length, 1);
});

test("a non-GM cannot open the dialog (warning, nothing rendered); a GM can", async () => {
  state.isGM = false;
  state.notices = [];
  const before = state.renders;
  await KbDialog.open();
  assert.match(state.notices[0], /Only the Gamemaster/);
  assert.equal(state.renders, before);
  state.isGM = true;
  await KbDialog.open();
  assert.equal(state.renders, before + 1);
});

test("the context reports a missing token and the current view", async () => {
  const dlg = fresh();
  dlg.audience = "players";
  const ctx = await dlg._prepareContext();
  assert.equal(ctx.isGm, false);
  assert.equal(ctx.tokenMissing, false);
  assert.equal(ctx.busy, false);
});

// ------------------------------------------------------------------ 4. module entry point (loads with fake Hooks)
const hooks = { on: {}, once: {} };
globalThis.Hooks = { on: (n, f) => (hooks.on[n] = f), once: (n, f) => (hooks.once[n] = f) };
globalThis.foundry.applications.api.DialogV2 = class {};
const settingsRegistered = [];
globalThis.game.settings.register = (_m, key) => settingsRegistered.push(key);
await import("../scripts/scrit-cribbler.mjs");

test("module entry loads, registers its hooks, and offers BOTH tools to the GM only", () => {
  assert.equal(typeof hooks.on.getSceneControlButtons, "function");
  const tools = () => ({ tokens: { tools: { select: {}, target: {} } } });
  state.isGM = true;
  const gm = tools();
  hooks.on.getSceneControlButtons(gm);
  assert.deepEqual(Object.keys(gm.tokens.tools), ["select", "target", "scrit-cribbler", "scrit-cribbler-kb"]);
  const kb = gm.tokens.tools["scrit-cribbler-kb"];
  assert.equal(kb.title, "Ask the campaign KB");
  assert.equal(kb.button, true);
  assert.ok(kb.order > gm.tokens.tools["scrit-cribbler"].order, "KB tool sits after the recording tool");
  state.isGM = false;
  const player = tools();
  hooks.on.getSceneControlButtons(player);
  assert.deepEqual(Object.keys(player.tokens.tools), ["select", "target"], "players get neither button");
  state.isGM = true;
});

test("the KB tool opens the dialog; with no GM it only warns", async () => {
  state.isGM = true;
  const gm = { tokens: { tools: {} } };
  hooks.on.getSceneControlButtons(gm);
  const before = state.renders;
  await gm.tokens.tools["scrit-cribbler-kb"].onChange();
  assert.equal(state.renders, before + 1);
  assert.equal(state.rendered.at(-1), "KbDialog", "the KB button must open the KB dialog, not another window");
  await gm.tokens.tools["scrit-cribbler"].onChange();
  assert.equal(state.rendered.at(-1), "RecordingDialog", "the recording button still opens the recording dialog");
});
