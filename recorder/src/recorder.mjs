import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Room, RoomEvent, AudioStream, TrackKind } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { config } from "./config.mjs";

const VOICE_THRESHOLD = 1000;      // |sample| above this counts as voiced (~ -30 dBFS)
const PAD_TOLERANCE = config.sampleRate / 4; // only pad gaps longer than 250 ms (absorbs jitter)

export const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
const chunkName = (i) => `chunk-${String(i).padStart(3, "0")}`;

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`))));
  });
}

/** Raw 16 kHz mono s16le writer for one speaker within one chunk, silence-padded to wall-clock time. */
class SpeakerWriter {
  constructor(dir, identity, chunkStartMs) {
    this.identity = identity;
    this.file = path.join(dir, `${slug(identity)}.pcm`);
    this.chunkStartMs = chunkStartMs;
    this.samples = 0;
    this.voiced = 0;
    this.stream = fs.createWriteStream(this.file);
  }

  write(frame) {
    // Frame arrives roughly when it ends; its start belongs at (elapsed - frame length).
    const elapsed = Math.floor(((Date.now() - this.chunkStartMs) / 1000) * config.sampleRate);
    const expectedStart = elapsed - frame.samplesPerChannel;
    const gap = expectedStart - this.samples;
    if (gap > PAD_TOLERANCE) {
      this.stream.write(Buffer.alloc(gap * 2));
      this.samples += gap;
    }
    const data = frame.data;
    for (let i = 0; i < data.length; i++) if (data[i] > VOICE_THRESHOLD || data[i] < -VOICE_THRESHOLD) this.voiced++;
    this.stream.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    this.samples += frame.samplesPerChannel;
  }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

class Chunk {
  constructor(session, index, startMs) {
    this.session = session;
    this.index = index;
    this.startMs = startMs;
    this.dir = path.join(session.dir, chunkName(index));
    fs.mkdirSync(this.dir, { recursive: true });
    this.writers = new Map();
  }

  writer(identity) {
    let w = this.writers.get(identity);
    if (!w) {
      w = new SpeakerWriter(this.dir, identity, this.startMs);
      this.writers.set(identity, w);
    }
    return w;
  }

  /** Close raw files, encode each speaker to Opus, build a mixed track, drop the raw PCM. */
  async finalize() {
    const speakers = [];
    for (const w of this.writers.values()) {
      await w.close();
      speakers.push({ identity: w.identity, pcm: w.file, voicedSeconds: w.voiced / config.sampleRate });
    }
    return encodeChunkDir(this.dir, speakers);
  }
}

const RAW_IN = ["-f", "s16le", "-ar", String(config.sampleRate), "-ac", "1"];

/** Encode every <speaker>.pcm in a chunk dir to .ogg plus mixed.ogg; returns speaker metadata. */
export async function encodeChunkDir(dir, speakers) {
  const out = [];
  for (const s of speakers) {
    const ogg = s.pcm.replace(/\.pcm$/, ".ogg");
    await runFfmpeg([...RAW_IN, "-i", s.pcm, "-c:a", "libopus", "-b:a", "24k", ogg]);
    out.push({ identity: s.identity, file: path.basename(ogg), voicedSeconds: Math.round(s.voicedSeconds * 10) / 10 });
  }
  if (speakers.length) {
    const inputs = speakers.flatMap((s) => [...RAW_IN, "-i", s.pcm]);
    const mix = speakers.length > 1
      ? ["-filter_complex", `amix=inputs=${speakers.length}:duration=longest:normalize=0`]
      : [];
    await runFfmpeg([...inputs, ...mix, "-c:a", "libopus", "-b:a", "32k", path.join(dir, "mixed.ogg")]);
  }
  for (const s of speakers) fs.rmSync(s.pcm, { force: true });
  return out;
}

/** Recover a chunk dir left with raw .pcm files (recorder crashed or restarted mid-chunk). */
export async function recoverChunkDir(dir) {
  const pcms = fs.readdirSync(dir).filter((f) => f.endsWith(".pcm"));
  const speakers = pcms.map((f) => {
    const pcm = path.join(dir, f);
    const buf = fs.readFileSync(pcm);
    const data = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    let voiced = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > VOICE_THRESHOLD || data[i] < -VOICE_THRESHOLD) voiced++;
    return { identity: f.replace(/\.pcm$/, ""), pcm, voicedSeconds: voiced / config.sampleRate };
  });
  return encodeChunkDir(dir, speakers);
}

/**
 * A live recording: joins the LiveKit room as a hidden, subscribe-only participant,
 * writes each speaker to its own file, and rotates to a new chunk every CHUNK_SECONDS.
 */
export class LiveRecording {
  constructor(session, { onChunkReady, onLog }) {
    this.session = session;
    this.onChunkReady = onChunkReady;
    this.log = onLog;
    this.room = null;
    this.chunk = null;
    this.rotateTimer = null;
    this.stopping = false;
    this.participants = new Map(); // identity -> { name, fvttUserId }
  }

  async token() {
    const at = new AccessToken(config.livekitKey, config.livekitSecret, {
      identity: config.botIdentity,
      name: "Scrit Cribbler",
      ttl: "12h"
    });
    at.addGrant({
      roomJoin: true,
      room: this.session.data.room,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
      hidden: true,
      recorder: true
    });
    return at.toJwt();
  }

  async start() {
    const s = this.session;
    this.chunk = new Chunk(s, s.data.chunks.length, Date.now());
    s.data.chunks.push({ index: this.chunk.index, startSec: s.elapsedSec(this.chunk.startMs), status: "recording" });
    s.save();
    await this.connect();
    this.rotateTimer = setInterval(() => this.rotate().catch((e) => this.log(`rotate failed: ${e.message}`)), config.chunkSeconds * 1000);
  }

  async connect() {
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      this.noteParticipant(participant);
      this.log(`audio subscribed: ${participant.identity}`);
      this.pump(track, participant.identity);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (this.stopping || this.room !== room) return;
      this.log(`disconnected from LiveKit (${reason}); reconnecting in 10 s`);
      setTimeout(() => this.reconnect(), 10000);
    });

    await room.connect(config.livekitUrl, await this.token(), { autoSubscribe: true, dynacast: false });
    this.log(`joined room ${this.session.data.room} (${room.remoteParticipants.size} participants present)`);
    for (const p of room.remoteParticipants.values()) this.noteParticipant(p);
  }

  async reconnect() {
    if (this.stopping) return;
    try {
      await this.connect();
    } catch (e) {
      this.log(`reconnect failed: ${e.message}; retrying in 30 s`);
      setTimeout(() => this.reconnect(), 30000);
    }
  }

  noteParticipant(p) {
    let fvttUserId = null;
    try { fvttUserId = JSON.parse(p.metadata || "{}").fvttUserId ?? null; } catch { /* not JSON */ }
    const known = this.session.data.participants;
    if (!known[p.identity]) {
      known[p.identity] = { name: p.name || p.identity, fvttUserId };
      this.session.save();
    }
  }

  async pump(track, identity) {
    const stream = new AudioStream(track, config.sampleRate, 1);
    try {
      for await (const frame of stream) {
        if (this.stopping) break;
        this.chunk.writer(identity).write(frame);
      }
    } catch (e) {
      this.log(`audio stream for ${identity} ended with error: ${e.message}`);
    }
  }

  async rotate() {
    const old = this.chunk;
    const s = this.session;
    this.chunk = new Chunk(s, old.index + 1, Date.now());
    s.data.chunks.push({ index: this.chunk.index, startSec: s.elapsedSec(this.chunk.startMs), status: "recording" });
    s.save();
    await this.finishChunk(old);
  }

  async finishChunk(chunk) {
    const entry = this.session.data.chunks[chunk.index];
    try {
      entry.speakers = await chunk.finalize();
      entry.status = "recorded";
    } catch (e) {
      entry.status = "error";
      entry.error = e.message;
      this.log(`chunk ${chunk.index} encode failed: ${e.message}`);
    }
    this.session.save();
    this.onChunkReady(this.session, chunk.index);
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.rotateTimer);
    const room = this.room;
    this.room = null;
    await room?.disconnect().catch(() => null);
    await this.finishChunk(this.chunk);
  }
}
