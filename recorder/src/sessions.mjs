import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.mjs";
import { slug } from "./recorder.mjs";

/** YYYY-MM-DD in the server's local time zone (sessions run in the evening; UTC would roll the date). */
export const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * One recording session, persisted as recordings/<world>/<stamp>-<name>/session.json.
 * States: recording -> processing -> done | error. "posted" flips once a GM client
 * has written the recap into the world's journal.
 */
export class Session {
  constructor(dir, data) {
    this.dir = dir;
    this.data = data;
  }

  static create({ world, worldTitle, room, sessionName, roster }) {
    const started = new Date();
    const stamp = `${localDate(started)}_${String(started.getHours()).padStart(2, "0")}${String(started.getMinutes()).padStart(2, "0")}`;
    const id = crypto.randomUUID();
    const dir = path.join(config.recordingsDir, slug(world), `${stamp}-${slug(sessionName)}`);
    fs.mkdirSync(dir, { recursive: true });
    const s = new Session(dir, {
      id,
      world,
      worldTitle: worldTitle || world,
      sessionName: sessionName || "Session",
      room,
      roster: roster || {},
      participants: {},
      startedAt: started.toISOString(),
      stoppedAt: null,
      state: "recording",
      chunks: [],
      error: null,
      recapFile: null,
      posted: false,
      log: []
    });
    s.save();
    return s;
  }

  static load(file) {
    return new Session(path.dirname(file), JSON.parse(fs.readFileSync(file, "utf8")));
  }

  get id() { return this.data.id; }

  elapsedSec(ms) {
    return Math.round((ms - Date.parse(this.data.startedAt)) / 100) / 10;
  }

  durationSec() {
    const end = this.data.stoppedAt ? Date.parse(this.data.stoppedAt) : Date.now();
    return Math.round((end - Date.parse(this.data.startedAt)) / 1000);
  }

  /** Display label for a LiveKit identity, using the Foundry roster the GM client sent. */
  label(identity) {
    const p = this.data.participants[identity];
    const r = p?.fvttUserId ? this.data.roster[p.fvttUserId] : null;
    const name = r?.name || p?.name || identity;
    if (r?.isGM) return `GM (${name})`;
    if (r?.character) return `${r.character} (${name})`;
    return name;
  }

  addLog(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(`[${this.data.sessionName}] ${msg}`);
    this.data.log.push(line);
    if (this.data.log.length > 200) this.data.log.splice(0, this.data.log.length - 200);
    this.save();
  }

  save() {
    const file = path.join(this.dir, "session.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** Compact view for the module's status polling. */
  summary() {
    const d = this.data;
    return {
      id: d.id,
      world: d.world,
      sessionName: d.sessionName,
      state: d.state,
      startedAt: d.startedAt,
      stoppedAt: d.stoppedAt,
      durationSec: this.durationSec(),
      chunks: d.chunks.map((c) => ({ index: c.index, status: c.status })),
      speakers: Object.keys(d.participants).map((i) => this.label(i)),
      error: d.error,
      posted: d.posted,
      recapFile: d.recapFile,
      recapStatus: d.recapStatus ?? null,
      lastLog: d.log.at(-1) ?? null
    };
  }
}

export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  loadAll() {
    if (!fs.existsSync(config.recordingsDir)) return;
    for (const world of fs.readdirSync(config.recordingsDir)) {
      const wdir = path.join(config.recordingsDir, world);
      if (!fs.statSync(wdir).isDirectory()) continue;
      for (const name of fs.readdirSync(wdir)) {
        const file = path.join(wdir, name, "session.json");
        if (!fs.existsSync(file)) continue;
        try {
          const s = Session.load(file);
          this.sessions.set(s.id, s);
        } catch (e) {
          console.error(`Could not load ${file}: ${e.message}`);
        }
      }
    }
  }

  add(s) { this.sessions.set(s.id, s); }
  get(id) { return this.sessions.get(id); }
  list(world) {
    return [...this.sessions.values()]
      .filter((s) => !world || s.data.world === world)
      .sort((a, b) => b.data.startedAt.localeCompare(a.data.startedAt));
  }
}
