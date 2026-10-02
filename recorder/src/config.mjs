import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIds, parseWorlds } from "./kbproxy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (KEY=VALUE per line, # comments). Real env vars win.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(path.join(ROOT, ".env"));

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required setting ${name} in ${path.join(ROOT, ".env")}`);
  return v;
}

export const config = {
  root: ROOT,
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 30010),
  apiToken: req("SCRIT_API_TOKEN"),

  livekitUrl: req("LIVEKIT_URL"),
  livekitKey: req("LIVEKIT_API_KEY"),
  livekitSecret: req("LIVEKIT_API_SECRET"),
  botIdentity: process.env.BOT_IDENTITY || "scrit-cribbler-recorder",
  // Player LiveKit tokens: Foundry is asked who a session cookie belongs to.
  foundryUrl: process.env.FOUNDRY_URL || "http://127.0.0.1:30000",
  // Allowed browser Origin for /livekit/token (default: https://<Host header>).
  foundryOrigin: process.env.FOUNDRY_ORIGIN || "",

  // GM lore Q&A (POST /kb/ask). Disabled unless BOTH are set. KB_GM_USER_IDS: comma-separated Foundry user ids
  // allowed to ask (the Gamemaster). KB_WORLDS: "world-id:campaign,..." maps a Foundry world to a knowledge base
  // folder name on the workstation, so the browser never chooses the folder.
  kbGmUserIds: parseIds(process.env.KB_GM_USER_IDS),
  kbWorlds: parseWorlds(process.env.KB_WORLDS),

  recordingsDir: process.env.RECORDINGS_DIR || "/mnt/foundryvtt/data/Data/scrit-cribbler/recordings",
  recapsDir: process.env.RECAPS_DIR || "/mnt/foundryvtt/data/Data/scrit-cribbler/recaps",
  chunkSeconds: Number(process.env.CHUNK_SECONDS || 600),
  sampleRate: 16000,

  backendUrl: req("BACKEND_URL"),
  backendToken: req("BACKEND_TOKEN"),
  backendCa: process.env.BACKEND_CA || "",
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",

  // Audio is deleted this many days after the recap is posted (0 = keep forever).
  audioRetentionDays: Number(process.env.AUDIO_RETENTION_DAYS ?? 60),
  // How often old audio is looked for: "daily" or "quarterly" (1 Jan/Apr/Jul/Oct).
  audioSweep: process.env.AUDIO_SWEEP === "quarterly" ? "quarterly" : "daily",
  // Recording refuses to start with less free space than this.
  minFreeGb: Number(process.env.MIN_FREE_GB ?? 2)
};
