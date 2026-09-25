import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.mjs";
import { LiveRecording, recoverChunkDir } from "./recorder.mjs";
import { Session, SessionStore } from "./sessions.mjs";
import { Pipeline } from "./pipeline.mjs";

const store = new SessionStore();
const pipeline = new Pipeline();
let active = null; // { session, recording }

function startProcessing(session) {
  for (const c of session.data.chunks) if (c.status === "recorded") pipeline.chunk(session, c.index);
  pipeline.finish(session);
}

/** Sessions interrupted by a recorder restart: salvage raw audio and process what exists. */
async function recover() {
  store.loadAll();
  for (const s of store.list()) {
    const d = s.data;
    if (d.state === "recording") {
      // Last audio written ~= when recording died. Read before salvage writes new files.
      const audioMtimes = fs.readdirSync(s.dir, { recursive: true })
        .filter((f) => /\.(pcm|ogg)$/.test(f))
        .map((f) => fs.statSync(path.join(s.dir, f)).mtimeMs);
      d.stoppedAt = new Date(audioMtimes.length ? Math.max(...audioMtimes) : Date.now()).toISOString();
      s.addLog("recorder restarted during recording; salvaging captured audio");
      for (const c of d.chunks) {
        if (c.status !== "recording") continue;
        const dir = path.join(s.dir, `chunk-${String(c.index).padStart(3, "0")}`);
        try {
          c.speakers = fs.existsSync(dir) ? await recoverChunkDir(dir) : [];
          c.status = "recorded";
        } catch (e) {
          c.status = "error";
          c.error = e.message;
        }
      }
      d.state = "processing";
      s.save();
      startProcessing(s);
    } else if (d.state === "processing") {
      s.addLog("recorder restarted during processing; resuming");
      startProcessing(s);
    }
  }
}

// ---------------------------------------------------------------- HTTP

const tokenBuf = Buffer.from(config.apiToken);
function authorized(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m) return false;
  const given = Buffer.from(m[1]);
  return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const part of req) {
    raw += part;
    if (raw.length > 256 * 1024) throw Object.assign(new Error("body too large"), { code: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid JSON"), { code: 400 }); }
}

const routes = [
  ["GET", /^\/health$/, false, () => [200, { ok: true, recording: active?.session.summary() ?? null }]],

  ["GET", /^\/sessions$/, true, (_req, _m, url) =>
    [200, { active: active?.session.id ?? null, sessions: store.list(url.searchParams.get("world")).map((s) => s.summary()) }]],

  ["GET", /^\/sessions\/([\w-]+)$/, true, (_req, m) => {
    const s = store.get(m[1]);
    return s ? [200, { ...s.summary(), log: s.data.log.slice(-30) }] : [404, { error: "no such session" }];
  }],

  ["POST", /^\/sessions\/start$/, true, async (req) => {
    if (active) return [409, { error: `Already recording "${active.session.data.sessionName}"`, active: active.session.summary() }];
    const b = await readJson(req);
    if (!b.world || !b.room) return [400, { error: "world and room are required" }];
    const session = Session.create({
      world: String(b.world),
      worldTitle: String(b.worldTitle || b.world),
      room: String(b.room),
      sessionName: String(b.sessionName || "Session").slice(0, 120),
      roster: typeof b.roster === "object" && b.roster ? b.roster : {}
    });
    store.add(session);
    const recording = new LiveRecording(session, {
      onChunkReady: (s, index) => pipeline.chunk(s, index),
      onLog: (msg) => session.addLog(msg)
    });
    try {
      await recording.start();
    } catch (e) {
      // Nothing was captured: drop the half-made session instead of queueing an empty chunk.
      recording.stopping = true;
      clearInterval(recording.rotateTimer);
      await recording.room?.disconnect().catch(() => null);
      await Promise.all([...(recording.chunk?.writers.values() ?? [])].map((w) => w.close()));
      store.sessions.delete(session.id);
      fs.rmSync(session.dir, { recursive: true, force: true });
      return [502, { error: `Could not join LiveKit room: ${e.message}` }];
    }
    active = { session, recording };
    return [200, session.summary()];
  }],

  ["POST", /^\/sessions\/([\w-]+)\/stop$/, true, async (_req, m) => {
    if (!active || active.session.id !== m[1]) return [409, { error: "that session is not recording" }];
    const { session, recording } = active;
    active = null;
    session.data.stoppedAt = new Date().toISOString();
    session.data.state = "processing";
    session.save();
    await recording.stop();
    session.addLog("recording stopped; processing");
    pipeline.finish(session);
    return [200, session.summary()];
  }],

  ["POST", /^\/sessions\/([\w-]+)\/reprocess$/, true, async (_req, m) => {
    const s = store.get(m[1]);
    if (!s) return [404, { error: "no such session" }];
    if (!["done", "error"].includes(s.data.state)) return [409, { error: `session is ${s.data.state}` }];
    for (const c of s.data.chunks) {
      if (c.speakers?.length) c.status = "recorded";
      else {
        const dir = path.join(s.dir, `chunk-${String(c.index).padStart(3, "0")}`);
        if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".pcm"))) {
          c.speakers = await recoverChunkDir(dir);
          c.status = "recorded";
        }
      }
    }
    Object.assign(s.data, { state: "processing", error: null, posted: false });
    s.addLog("reprocess requested");
    startProcessing(s);
    return [200, s.summary()];
  }],

  ["GET", /^\/sessions\/([\w-]+)\/result$/, true, (_req, m) => {
    const s = store.get(m[1]);
    if (!s) return [404, { error: "no such session" }];
    if (s.data.state !== "done") return [409, { error: `session is ${s.data.state}` }];
    const d = s.data;
    return [200, {
      ...s.summary(),
      summary: d.summary,
      recapStatus: d.recapStatus ?? "ok",
      recapNote: d.recapNote ?? null,
      unverifiedTerms: d.unverifiedTerms ?? [],
      notes: d.notes ?? null,
      spokenSpeakers: d.spokenSpeakers ?? [],
      model: d.model,
      transcript: pipeline.transcript(s)
    }];
  }],

  ["POST", /^\/sessions\/([\w-]+)\/posted$/, true, (_req, m) => {
    const s = store.get(m[1]);
    if (!s) return [404, { error: "no such session" }];
    s.data.posted = true;
    s.save();
    return [200, s.summary()];
  }]
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  for (const [method, re, needsAuth, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m || req.method !== method) continue;
    if (needsAuth && !authorized(req)) return send(res, 401, { error: "unauthorized" });
    try {
      const [code, body] = await handler(req, m, url);
      return send(res, code, body);
    } catch (e) {
      console.error(`${req.method} ${url.pathname}:`, e);
      return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
    }
  }
  send(res, 404, { error: "not found" });
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  if (active) {
    // Leave state "recording" so the next start salvages and processes it.
    const rec = active.recording;
    rec.stopping = true;
    await rec.room?.disconnect().catch(() => null);
    await Promise.all([...(rec.chunk?.writers.values() ?? [])].map((w) => w.close()));
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await recover();
server.listen(config.port, config.host, () => console.log(`scrit-recorder listening on ${config.host}:${config.port}`));
