import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { runFfmpeg } from "./recorder.mjs";

/**
 * Recording retention. Audio is only needed to Reprocess; transcripts, notes, the report
 * and the .md recap are kept (small, and they are the record). Players get one promise:
 * audio is deleted AUDIO_RETENTION_DAYS after the recap is posted, unless the GM marked
 * the session "keep audio".
 *
 * The sweep runs once per period (daily, or on the first day of each quarter), checked
 * hourly and at startup. The last run is stored on disk, so restarts neither skip nor
 * repeat a sweep. The period only decides WHEN old audio is looked for; audio younger than
 * the retention age is never touched, whatever the period.
 */
const SWEEP_FILE = () => path.join(config.recordingsDir, ".sweep.json");
const DAY_MS = 24 * 60 * 60 * 1000;

export const retentionDays = () => config.audioRetentionDays;

/** Start of the sweep period containing `now` (local time). */
export function periodStart(now, mode) {
  const d = new Date(now);
  if (mode === "quarterly") return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function sweepDue(lastRunMs, now, mode) {
  return !lastRunMs || lastRunMs < periodStart(now, mode);
}

/** When a session's audio becomes eligible for deletion (ms), or null if never. */
export function audioExpiresAt(data) {
  if (!config.audioRetentionDays || data.keepAudio || data.audioDeletedAt) return null;
  if (!["done", "error"].includes(data.state)) return null;
  const from = Date.parse(data.postedAt || data.stoppedAt || data.startedAt);
  return from + config.audioRetentionDays * DAY_MS;
}

/** Audio files of a session: per-speaker and mixed .ogg, plus any unsalvaged .pcm. */
export function audioFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .filter((f) => /(^|\/)chunk-\d+\/[^/]+\.(ogg|pcm)$/.test(f))
    .map((f) => path.join(dir, f));
}

export function sizeBytes(files) {
  return files.reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
}

/** Delete a finished session's audio (keeps transcripts, notes, recap). */
export function deleteAudio(session, reason) {
  const files = audioFiles(session.dir);
  const bytes = sizeBytes(files);
  for (const f of files) fs.rmSync(f, { force: true });
  session.data.audioDeletedAt = new Date().toISOString();
  session.addLog(`audio deleted (${reason}): ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
  return { files: files.length, bytes };
}

export function sweep(store, now = Date.now()) {
  let sessions = 0, bytes = 0;
  for (const s of store.list()) {
    const due = audioExpiresAt(s.data);
    if (due == null || due > now) continue;
    const r = deleteAudio(s, `older than ${config.audioRetentionDays} days`);
    sessions++;
    bytes += r.bytes;
  }
  fs.writeFileSync(SWEEP_FILE(), JSON.stringify({ lastRunAt: new Date(now).toISOString(), mode: config.audioSweep, sessions, bytes }, null, 2));
  console.log(`audio sweep (${config.audioSweep}, ${config.audioRetentionDays} days): ${sessions} session(s), ${(bytes / 1e6).toFixed(1)} MB freed`);
  return { sessions, bytes };
}

function lastSweep() {
  try {
    return Date.parse(JSON.parse(fs.readFileSync(SWEEP_FILE(), "utf8")).lastRunAt) || 0;
  } catch {
    return 0;
  }
}

/** Run the sweep now if this period's run is missing, then check hourly. */
export function scheduleSweep(store) {
  const check = () => {
    try {
      if (config.audioRetentionDays && sweepDue(lastSweep(), Date.now(), config.audioSweep)) sweep(store);
    } catch (e) {
      console.error("audio sweep failed:", e);
    }
  };
  check();
  return setInterval(check, 60 * 60 * 1000);
}

/**
 * Remove one person from a finished session: their per-speaker audio, the mixed track
 * (rebuilt from everyone else), their lines in the transcripts, and the notes and recap
 * built from them. The caller reprocesses afterwards, so the recap is rewritten without
 * them. Journal pages already posted are the GM's to delete.
 */
export async function removeSpeaker(session, identity) {
  const d = session.data;
  const label = session.label(identity);
  let files = 0;
  for (const c of d.chunks) {
    const dir = path.join(session.dir, `chunk-${String(c.index).padStart(3, "0")}`);
    const mine = (c.speakers || []).filter((sp) => sp.identity === identity);
    if (!mine.length) continue;
    for (const sp of mine) {
      fs.rmSync(path.join(dir, sp.file), { force: true });
      files++;
    }
    c.speakers = c.speakers.filter((sp) => sp.identity !== identity);
    const mixed = path.join(dir, "mixed.ogg");
    fs.rmSync(mixed, { force: true });
    const rest = c.speakers.map((sp) => path.join(dir, sp.file)).filter((f) => fs.existsSync(f));
    if (rest.length) {
      const mix = rest.length > 1 ? ["-filter_complex", `amix=inputs=${rest.length}:duration=longest:normalize=0`] : [];
      await runFfmpeg([...rest.flatMap((f) => ["-i", f]), ...mix, "-c:a", "libopus", "-b:a", "32k", mixed]);
    }
    for (const name of ["transcript.json", "transcript.raw.json"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const lines = JSON.parse(fs.readFileSync(file, "utf8")).filter((l) => l.speaker !== label);
      fs.writeFileSync(file, JSON.stringify(lines, null, 2));
    }
    fs.rmSync(path.join(dir, "notes.md"), { force: true });
    delete c.report;
  }
  if (d.recapFile) fs.rmSync(d.recapFile, { force: true });
  Object.assign(d, { summary: null, notes: null, recapFile: null });
  d.removedSpeakers = [...new Set([...(d.removedSpeakers || []), label])];
  delete d.participants[identity];
  session.addLog(`removed speaker ${label}: ${files} audio file(s), transcript lines, notes and recap`);
  return { label, files };
}

/** Whole session: folder (audio, transcripts, notes), recap .md, and the store entry. */
export function deleteSession(store, session) {
  if (session.data.recapFile) fs.rmSync(session.data.recapFile, { force: true });
  fs.rmSync(session.dir, { recursive: true, force: true });
  store.remove(session.id);
  console.log(`[${session.data.sessionName}] session deleted`);
}

export function freeBytes(dir = config.recordingsDir) {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}
