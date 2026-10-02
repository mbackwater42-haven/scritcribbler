import crypto from "node:crypto";

// GM-only lore Q&A: POST /kb/ask. The browser asks the recorder, the recorder asks the backend on
// the workstation (which holds the campaign knowledge base). The knowledge base can contain GM
// secrets, so every layer below must pass, cheapest first, before any expensive work happens:
//
//   1. route enabled (KB_GM_USER_IDS and KB_WORLDS both set), else 404
//   2. Origin equals the Foundry origin       (the browser sends the Foundry cookie by itself, so this is the CSRF defence)
//   3. Content-Type is application/json
//   4. per-IP rate limit                      (before the body is read and before Foundry is contacted)
//   5. body read, capped at 4 KB
//   6. Authorization: Bearer <SCRIT_API_TOKEN>  (kept only in the GM's browser)
//   7. Foundry session cookie -> userId must be in KB_GM_USER_IDS
//   8. per-GM rate limit, and one question in flight at a time
//   9. only whitelisted fields are forwarded; the campaign comes from KB_WORLDS, never from the browser
//
// Questions, answers and sources are never logged: one summary line per request, nothing else.
// Dependencies are injected so this file has no imports from config or the network (see tests/test_kbproxy.mjs).

export const MAX_BODY = 4096;
export const MAX_QUESTION = 500;
const SESSION_RE = /^[A-Za-z0-9]{1,64}$/;
const WORLD_RE = /^[\w.-]{1,128}$/;
const CAMPAIGN_RE = /^[a-z0-9]{1,32}$/;

/** "world:campaign,world2:campaign2" -> { world: campaign }; malformed entries are ignored. */
export function parseWorlds(text) {
  const out = {};
  for (const part of String(text ?? "").split(",")) {
    const [world, campaign] = part.split(":").map((s) => s?.trim());
    if (WORLD_RE.test(world ?? "") && CAMPAIGN_RE.test(campaign ?? "")) out[world] = campaign;
  }
  return out;
}

export const parseIds = (text) => String(text ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9]{1,64}$/.test(s));

/** Fixed-window limiter. check(key) -> true when the caller is over the limit. */
export function limiter(max, windowMs, now = Date.now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.start > windowMs) {
      hits.set(key, { start: t, n: 1 });
      if (hits.size > 1000) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
      return false;
    }
    return ++h.n > max;
  };
}

/** nginx appends the real client address last in X-Forwarded-For. */
export function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || req.socket?.remoteAddress || "unknown";
}

export function sessionCookie(req) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "session") {
      try { return decodeURIComponent(v.join("=")); } catch { return null; }
    }
  }
  return null;
}

/**
 * deps: { apiToken, gmUserIds[], worlds{}, foundryOrigin, foundryUserId(cookie)->Promise<id|null>,
 *         callBackend(body)->Promise<{status, body}>, now?, log? }
 * Returns handle(req, readBody) -> Promise<[httpCode, jsonBody]>. readBody() runs only after the cheap checks.
 */
export function createKbRoute(deps) {
  const { apiToken, gmUserIds, worlds, foundryOrigin, foundryUserId, callBackend } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.log(line));
  const ipLimit = limiter(10, 60_000, now);       // 10 / minute per client address
  const gmLimit = limiter(20, 10 * 60_000, now);  // 20 / 10 minutes per GM
  const tokenBuf = Buffer.from(apiToken || "");
  const enabled = gmUserIds.length > 0 && Object.keys(worlds).length > 0 && tokenBuf.length > 0;
  let inFlight = false;

  const deny = (code, reason, msg, ip) => {
    log(`kb ask denied reason=${reason} ip=${ip}`);
    return [code, { error: msg }];
  };

  return async function handle(req, readBody) {
    if (!enabled) return [404, { error: "not found" }];
    const ip = clientIp(req);

    const expected = foundryOrigin || `https://${req.headers.host}`;
    if (!req.headers.origin || req.headers.origin !== expected) return deny(403, "origin", "bad origin", ip);
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) return deny(415, "content-type", "JSON only", ip);
    if (ipLimit(ip)) return deny(429, "ip-rate", "too many requests", ip);

    const body = await readBody(); // throws {code: 413|400} on an oversize or invalid body

    const m = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
    const given = Buffer.from(m?.[1] ?? "");
    if (!m || given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) return deny(401, "token", "unauthorized", ip);

    const cookie = sessionCookie(req);
    if (!cookie || !SESSION_RE.test(cookie)) return deny(401, "no-session", "not logged in to Foundry", ip);
    const userId = await foundryUserId(cookie);
    if (!userId) return deny(401, "session-invalid", "not logged in to Foundry", ip);
    if (!gmUserIds.includes(userId)) return deny(403, "not-gm", "GM only", ip);

    if (gmLimit(userId)) return deny(429, "gm-rate", "too many questions, wait a few minutes", ip);
    if (inFlight) return deny(429, "in-flight", "a question is already being answered", ip);

    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question || question.length > MAX_QUESTION) return [400, { error: `question is required (at most ${MAX_QUESTION} characters)` }];
    const audience = body.audience ?? "gm";
    if (audience !== "gm" && audience !== "players") return [400, { error: "audience must be gm or players" }];
    const campaign = typeof body.world === "string" && Object.hasOwn(worlds, body.world) ? worlds[body.world] : null;
    if (!campaign) return [404, { error: "no knowledge base for this world" }];

    inFlight = true;
    const t0 = now();
    let code = 502;
    try {
      let r;
      try {
        r = await callBackend({ campaign, question, audience });
      } catch {
        return [502, { error: "knowledge base unavailable" }];
      }
      if (r.status === 200 && r.body?.status === "success") {
        code = 200;
        const { answer, model, sources, seconds } = r.body;
        return [200, { status: "success", answer, model, audience, seconds, sources: Array.isArray(sources) ? sources.map((s) => ({
          n: s.n, file: s.file, heading: s.heading, reliability: s.reliability, cited: !!s.cited, text: s.text })) : [] }];
      }
      if (r.status === 503) { code = 503; return [503, { error: "The model is busy (a recap may be running). Try again in a minute." }]; }
      return [502, { error: "knowledge base unavailable" }]; // no backend details leak to the browser
    } finally {
      inFlight = false;
      log(`kb ask user=${userId} audience=${audience} question_chars=${question.length} status=${code} ms=${now() - t0}`);
    }
  };
}
