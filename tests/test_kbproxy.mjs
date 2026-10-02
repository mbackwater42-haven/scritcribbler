// Offline checks for recorder/src/kbproxy.mjs (no network, no Foundry, no real campaign data).
// Run: node --test tests/test_kbproxy.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_QUESTION, createKbRoute, limiter, parseIds, parseWorlds } from "../recorder/src/kbproxy.mjs";

const TOKEN = "tok-abc123";
const GM = "gmUser1";
const PLAYER = "playerUser9";
const ORIGIN = "https://foundry.example.test";

/** Build a route plus counters that show which expensive steps ran. */
function setup(over = {}) {
  const calls = { foundry: 0, backend: [], body: 0, log: [] };
  let t = 1_000_000;
  const deps = {
    apiToken: TOKEN,
    gmUserIds: [GM],
    worlds: { "world-a": "demo" },
    foundryOrigin: ORIGIN,
    foundryUserId: async (cookie) => { calls.foundry++; return { goodcookie: GM, playercookie: PLAYER, othercookie: "unlisted42" }[cookie] ?? null; },
    callBackend: async (b) => { calls.backend.push(b); return { status: 200, body: { status: "success", answer: "An answer [1].", model: "m", seconds: 1.2, secretBackendField: "x",
      sources: [{ n: 1, file: "recap_01.md", heading: "Recap", reliability: "r", cited: true, text: "t", score: 0.5, leakedExtra: "y" }] } }; },
    now: () => t,
    log: (l) => calls.log.push(l),
    ...over
  };
  const handle = createKbRoute(deps);
  const req = (o = {}) => ({
    headers: {
      origin: ORIGIN, "content-type": "application/json", authorization: `Bearer ${TOKEN}`, cookie: "session=goodcookie",
      host: "foundry.example.test", "x-forwarded-for": o.ip ?? "203.0.113.5", ...(o.headers ?? {})
    },
    socket: { remoteAddress: "127.0.0.1" }
  });
  const ask = (o = {}, body = { world: "world-a", question: "Who bought the clockwork owl?" }) =>
    handle(req(o), async () => { calls.body++; if (body instanceof Error) throw body; return body; });
  return { ask, calls, advance: (ms) => { t += ms; }, req, handle };
}

test("success: GM with token, cookie and origin gets the answer; only whitelisted fields come back", async () => {
  const { ask, calls } = setup();
  const [code, body] = await ask();
  assert.equal(code, 200);
  assert.equal(body.answer, "An answer [1].");
  assert.equal(body.secretBackendField, undefined);
  assert.deepEqual(Object.keys(body.sources[0]).sort(), ["cited", "file", "heading", "n", "reliability", "text"]);
  assert.deepEqual(calls.backend, [{ campaign: "demo", question: "Who bought the clockwork owl?", audience: "gm" }]);
});

test("route is disabled (404, nothing runs) unless GM ids, worlds and token are all set", async () => {
  for (const over of [{ gmUserIds: [] }, { worlds: {} }, { apiToken: "" }]) {
    const { ask, calls } = setup(over);
    const [code] = await ask();
    assert.equal(code, 404);
    assert.equal(calls.body + calls.foundry + calls.backend.length, 0);
  }
});

test("Origin: missing or wrong -> 403 before anything else; default is https://<Host>", async () => {
  const { ask, calls } = setup();
  assert.equal((await ask({ headers: { origin: undefined } }))[0], 403);
  assert.equal((await ask({ headers: { origin: "https://evil.example" } }))[0], 403);
  assert.equal(calls.body + calls.foundry, 0);
  const d = setup({ foundryOrigin: "" });
  assert.equal((await d.ask({ headers: { origin: "https://foundry.example.test" } }))[0], 200);
  assert.equal((await d.ask({ headers: { origin: "https://other.test" } }))[0], 403);
});

test("Content-Type must be JSON -> 415", async () => {
  const { ask, calls } = setup();
  assert.equal((await ask({ headers: { "content-type": "text/plain" } }))[0], 415);
  assert.equal((await ask({ headers: { "content-type": undefined } }))[0], 415);
  assert.equal(calls.body + calls.foundry, 0);
});

test("per-IP rate limit (10/min) answers 429 BEFORE the body is read or Foundry is contacted", async () => {
  const { ask, calls, advance } = setup();
  for (let i = 0; i < 10; i++) assert.notEqual((await ask({ headers: { authorization: "Bearer wrong" } }))[0], 429);
  const bodyBefore = calls.body, foundryBefore = calls.foundry;
  const [code] = await ask({ headers: { authorization: "Bearer wrong" } });
  assert.equal(code, 429);
  assert.equal(calls.body, bodyBefore, "body must not be read for a limited request");
  assert.equal(calls.foundry, foundryBefore, "Foundry must not be contacted for a limited request");
  advance(61_000);
  assert.notEqual((await ask())[0], 429, "window resets after a minute");
});

test("the client address is the LAST X-Forwarded-For entry (the one nginx appends), not a spoofable first one", async () => {
  const { ask } = setup();
  for (let i = 0; i < 10; i++) await ask({ ip: `1.1.1.${i}, 9.9.9.9` });
  assert.equal((await ask({ ip: "2.2.2.2, 9.9.9.9" }))[0], 429, "same last hop = same client");
  assert.notEqual((await ask({ ip: "1.1.1.1, 8.8.8.8" }))[0], 429, "different last hop = different client");
});

test("oversize or invalid body surfaces the reader's error (413 / 400) before token and cookie checks", async () => {
  const { ask, calls } = setup();
  await assert.rejects(ask({}, Object.assign(new Error("body too large"), { code: 413 })), (e) => e.code === 413);
  await assert.rejects(ask({}, Object.assign(new Error("invalid JSON"), { code: 400 })), (e) => e.code === 400);
  assert.equal(calls.foundry, 0);
});

test("token: missing, wrong, wrong length -> 401 and Foundry is NOT contacted", async () => {
  const { ask, calls } = setup();
  for (const authorization of [undefined, "", "Bearer ", "Bearer wrong-token", `Bearer ${TOKEN}x`, "Bearer t", TOKEN]) {
    assert.equal((await ask({ headers: { authorization }, ip: `10.0.0.${Math.floor(Math.random() * 200)}` }))[0], 401);
  }
  assert.equal(calls.foundry, 0);
  assert.equal(calls.backend.length, 0);
});

test("cookie: missing, malformed, or not logged in -> 401; a valid session in the allowlist is required", async () => {
  const { ask, calls } = setup();
  assert.equal((await ask({ headers: { cookie: undefined }, ip: "10.1.0.1" }))[0], 401);
  assert.equal((await ask({ headers: { cookie: "session=bad cookie;drop" }, ip: "10.1.0.2" }))[0], 401);
  assert.equal((await ask({ headers: { cookie: "other=1" }, ip: "10.1.0.3" }))[0], 401);
  assert.equal((await ask({ headers: { cookie: "session=unknowncookie" }, ip: "10.1.0.4" }))[0], 401);
  assert.equal(calls.backend.length, 0);
});

test("a logged-in player, or any user not in KB_GM_USER_IDS, gets 403 and nothing reaches the backend", async () => {
  const { ask, calls } = setup();
  assert.equal((await ask({ headers: { cookie: "session=playercookie" }, ip: "10.2.0.1" }))[0], 403);
  assert.equal((await ask({ headers: { cookie: "session=othercookie" }, ip: "10.2.0.2" }))[0], 403);
  assert.equal(calls.backend.length, 0);
});

test("only whitelisted fields are forwarded; the campaign comes from KB_WORLDS, never the browser", async () => {
  const { ask, calls } = setup();
  await ask({}, { world: "world-a", question: "q", campaign: "../etc", k: 99, answer: false, model: "huge", audience: "players", extra: 1 });
  assert.deepEqual(calls.backend[0], { campaign: "demo", question: "q", audience: "players" });
  assert.equal((await ask({ ip: "10.3.0.1" }, { world: "unknown", question: "q" }))[0], 404);
  assert.equal((await ask({ ip: "10.3.0.2" }, { world: "__proto__", question: "q" }))[0], 404);
  assert.equal((await ask({ ip: "10.3.0.3" }, { question: "q" }))[0], 404);
});

test("question and audience are validated", async () => {
  const { ask } = setup();
  const bad = [{ world: "world-a" }, { world: "world-a", question: "   " }, { world: "world-a", question: 5 },
    { world: "world-a", question: "x".repeat(MAX_QUESTION + 1) }, { world: "world-a", question: "q", audience: "everyone" }];
  let n = 0;
  for (const b of bad) assert.equal((await ask({ ip: `10.4.0.${n++}` }, b))[0], 400);
  assert.equal((await ask({ ip: "10.4.1.1" }, { world: "world-a", question: "x".repeat(MAX_QUESTION) }))[0], 200);
});

test("per-GM limit: the 21st question in 10 minutes is refused", async () => {
  const { ask, advance } = setup();
  for (let i = 0; i < 20; i++) { assert.equal((await ask({ ip: `10.5.${i}.1` }))[0], 200); advance(1000); }
  assert.equal((await ask({ ip: "10.5.99.1" }))[0], 429);
  advance(10 * 60_000);
  assert.equal((await ask({ ip: "10.5.99.2" }))[0], 200);
});

test("one question in flight at a time: a second one is refused until the first finishes", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ask, calls } = setup({ callBackend: async (b) => { await gate; return { status: 200, body: { status: "success", answer: "late", sources: [] } }; } });
  const first = ask({ ip: "10.6.0.1" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await ask({ ip: "10.6.0.2" }))[0], 429);
  release();
  assert.equal((await first)[0], 200);
  assert.equal((await ask({ ip: "10.6.0.3" }))[0], 200);
  assert.equal(calls.foundry >= 3, true);
});

test("backend busy -> 503 with a friendly message; backend failure -> generic 502, no details; both release the slot", async () => {
  const modes = [{ status: 503, body: { status: "busy", error: "internal detail" } }, { status: 500, body: { error: "Traceback: SECRET PATH C:\\x" } },
    { status: 404, body: { error: "unknown campaign" } }, "throw"];
  const expected = [503, 502, 502, 502];
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i];
    const { ask } = setup({ callBackend: async () => { if (m === "throw") throw new Error("ECONNREFUSED 10.0.0.7"); return m; } });
    const [code, body] = await ask({ ip: `10.7.${i}.1` });
    assert.equal(code, expected[i]);
    assert.doesNotMatch(JSON.stringify(body), /SECRET|Traceback|ECONNREFUSED|10\.0\.0\.7|internal detail|C:/);
    assert.equal((await ask({ ip: `10.7.${i}.2` }))[0], expected[i], "slot was released, so the second call reaches the backend again");
  }
});

test("logs: one summary line per request, never the question, answer, token or cookie", async () => {
  const { ask, calls } = setup();
  await ask({}, { world: "world-a", question: "SECRETQUESTIONWORD villain" });
  await ask({ headers: { authorization: "Bearer wrong-token-value" }, ip: "10.8.0.1" });
  const log = calls.log.join("\n");
  assert.match(log, /kb ask user=gmUser1 audience=gm question_chars=\d+ status=200 ms=\d+/);
  assert.match(log, /kb ask denied reason=token/);
  for (const secret of ["SECRETQUESTIONWORD", "An answer", TOKEN, "wrong-token-value", "goodcookie", "clockwork"]) assert.equal(log.includes(secret), false, `${secret} must not be logged`);
});

test("helpers: parseWorlds, parseIds, limiter", () => {
  assert.deepEqual(parseWorlds("a-b:cdop, c.d:other,bad,:x,e:UP,f:ok"), { "a-b": "cdop", "c.d": "other", f: "ok" });
  assert.deepEqual(parseIds(" a1, b2 ,,bad id,../x"), ["a1", "b2"]);
  const lim = limiter(2, 1000, () => 5);
  assert.deepEqual([lim("k"), lim("k"), lim("k"), lim("other")], [false, false, true, false]);
});
