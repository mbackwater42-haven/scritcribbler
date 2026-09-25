import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  recordingsDir: process.env.RECORDINGS_DIR || "/mnt/foundryvtt/data/Data/scrit-cribbler/recordings",
  recapsDir: process.env.RECAPS_DIR || "/mnt/foundryvtt/data/Data/scrit-cribbler/recaps",
  chunkSeconds: Number(process.env.CHUNK_SECONDS || 600),
  sampleRate: 16000,

  backendUrl: req("BACKEND_URL"),
  backendToken: req("BACKEND_TOKEN"),
  backendCa: process.env.BACKEND_CA || "",
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg"
};
