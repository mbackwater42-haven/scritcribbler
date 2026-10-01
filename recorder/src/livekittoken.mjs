import { AccessToken } from "livekit-server-sdk";
import { io } from "socket.io-client";
import { config } from "./config.mjs";

// LiveKit tokens for Foundry players, minted here so the API secret never reaches browsers.
// The caller proves who they are with their Foundry "session" cookie: we open a short
// socket to Foundry with it and Foundry answers with the userId logged in to the world.

const SESSION_RE = /^[A-Za-z0-9]{1,64}$/;
const ROOM_RE = /^[\w.-]{1,128}$/;

/** userId for a Foundry session cookie value, or null if not logged in to the active world. */
export function foundryUserId(sessionId) {
  return new Promise((resolve) => {
    const socket = io(config.foundryUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      upgrade: false,
      reconnection: false,
      timeout: 5000,
      extraHeaders: { Cookie: `session=${sessionId}` }
    });
    const done = (userId) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(userId);
    };
    const timer = setTimeout(() => done(null), 6000);
    socket.on("session", (s) => done(s?.userId ?? null));
    socket.on("connect_error", () => done(null));
  });
}

// Simple fixed-window rate limit per client IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > 5 * 60_000) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 1000) for (const [k, v] of hits) if (now - v.start > 5 * 60_000) hits.delete(k);
    return false;
  }
  return ++h.n > 20;
}

/** nginx appends the real client address last in X-Forwarded-For. */
function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || req.socket.remoteAddress || "unknown";
}

function sessionCookie(req) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "session") return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Route handler: POST /livekit/token {room, name, useExternalAV} -> {token}. */
export async function tokenRoute(req, body) {
  const origin = req.headers.origin;
  const expected = config.foundryOrigin || `https://${req.headers.host}`;
  if (!origin || origin !== expected) return [403, { error: "bad origin" }];
  if (!(req.headers["content-type"] || "").startsWith("application/json")) return [415, { error: "JSON only" }];
  if (rateLimited(clientIp(req))) return [429, { error: "too many requests" }];

  const room = String(body.room ?? "");
  if (!ROOM_RE.test(room)) return [400, { error: "bad room" }];

  const sessionId = sessionCookie(req);
  if (!sessionId || !SESSION_RE.test(sessionId)) return [401, { error: "not logged in to Foundry" }];
  const userId = await foundryUserId(sessionId);
  if (!userId) return [401, { error: "not logged in to Foundry" }];

  // Identity and fvttUserId come from the verified user; the display name is cosmetic only.
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : userId;
  const at = new AccessToken(config.livekitKey, config.livekitSecret, {
    identity: userId,
    name,
    ttl: "10h",
    metadata: JSON.stringify({ fvttUserId: userId, useExternalAV: body.useExternalAV === true })
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  return [200, { token: await at.toJwt() }];
}
