// Server-side replay cache for the 2D viewer. Each demo in DEMOS_DIR is parsed once by the
// `replay` binary (the viewer's own Go parser, built natively in the Dockerfile) into a small
// gzip file of protobuf frames, which "Watch 2D" downloads instead of the whole .dem.
//
// Cache files live in REPLAY_DIR (default DATA_DIR/replays, persistent):
//   <key>.rpl  replay data (gzip)       <key>.err  why parsing failed (plain text)
// The key hashes the demo's relative path, size and mtime, so a demo that changes is parsed again.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { listDemoFiles } from './demos.js';
import { VIEWER_EXT_RE } from './viewer.js';

// A demo that is still being recorded keeps changing; only parse files left alone this long.
const STABLE_MS = 2 * 60 * 1000;

export function replayKey(relPath, size, mtimeMs) {
  return crypto.createHash('sha256').update(`${relPath}\0${size}\0${Math.floor(mtimeMs)}`).digest('hex').slice(0, 32);
}

function lastErrorLine(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{'));
  return (lines.at(-1) || 'parser failed').slice(0, 500);
}

export class ReplayCache {
  constructor({ demosDir, cacheDir, bin, threads = 4, timeoutMs = 20 * 60 * 1000, log = console, now = Date.now }) {
    Object.assign(this, { demosDir, cacheDir, bin, threads, timeoutMs, log, now });
    this.queue = []; // [{ key, rel, abs }]
    this.queued = new Set();
    this.running = null; // key
  }

  get enabled() {
    try {
      fs.accessSync(this.bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  file(key, ext) {
    return path.join(this.cacheDir, `${key}.${ext}`);
  }

  /** { state: 'ready', file } | { state: 'failed', error } | { state: 'pending', position } */
  async status(key) {
    if (await fsp.stat(this.file(key, 'rpl')).then((s) => s.isFile(), () => false)) return { state: 'ready', file: this.file(key, 'rpl') };
    const err = await fsp.readFile(this.file(key, 'err'), 'utf8').catch(() => null);
    if (err != null) return { state: 'failed', error: err.trim() || 'parser failed' };
    if (this.running === key) return { state: 'pending', position: 0 };
    const i = this.queue.findIndex((j) => j.key === key);
    return { state: 'pending', position: i === -1 ? null : i + 1 };
  }

  /** Queue a demo; `urgent` puts it at the front (someone is waiting for it). */
  enqueue(job, urgent = false) {
    if (this.running === job.key) return;
    if (this.queued.has(job.key)) {
      if (urgent) {
        const i = this.queue.findIndex((j) => j.key === job.key);
        if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
      }
      return;
    }
    this.queued.add(job.key);
    if (urgent) this.queue.unshift(job);
    else this.queue.push(job);
    this.pump();
  }

  /** Resolves when the queue is idle (used by tests). */
  idle() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => { (this.idleWaiters ||= []).push(resolve); });
  }

  async pump() {
    if (this.running || !this.queue.length) {
      if (!this.running && !this.queue.length && this.idleWaiters) {
        const w = this.idleWaiters;
        this.idleWaiters = null;
        w.forEach((r) => r());
      }
      return;
    }
    const job = this.queue.shift();
    this.queued.delete(job.key);
    this.running = job.key;
    const started = this.now();
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      await this.parse(job);
      this.log.log?.(`[replay] ${job.rel} ready in ${((this.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      this.log.warn?.(`[replay] ${job.rel} failed: ${e.message}`);
      await fsp.writeFile(this.file(job.key, 'err'), `${e.message}\n`).catch(() => {});
    } finally {
      this.running = null;
      setImmediate(() => this.pump());
    }
  }

  parse(job) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, [job.abs, this.file(job.key, 'rpl')], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH || '', GOMAXPROCS: String(this.threads) },
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8192); });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(signal ? `parser stopped (${signal})` : lastErrorLine(stderr)));
      });
    });
  }

  /** Describe a demo file for the cache, or null if the viewer can't read it or it is still being written. */
  async jobFor(rel, abs, { requireStable = true } = {}) {
    if (!VIEWER_EXT_RE.test(rel)) return null;
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return null;
    if (requireStable && this.now() - st.mtimeMs < STABLE_MS) return null;
    return { key: replayKey(rel, st.size, st.mtimeMs), rel, abs };
  }

  /** Queue every demo without a cached replay, and delete cache files whose demo is gone or changed. */
  async scan() {
    if (!this.enabled) return;
    const files = await listDemoFiles(this.demosDir);
    const keep = new Set();
    for (const f of files) {
      if (!VIEWER_EXT_RE.test(f.path)) continue;
      const key = replayKey(f.path, f.size, f.mtime);
      keep.add(key);
      if (this.now() - f.mtime < STABLE_MS) continue;
      const s = await this.status(key);
      if (s.state === 'pending' && s.position == null) this.enqueue({ key, rel: f.path, abs: path.join(this.demosDir, f.path) });
    }
    if (!files.length && !(await fsp.stat(this.demosDir).catch(() => null))) return; // demos folder missing: keep cache
    const names = await fsp.readdir(this.cacheDir).catch(() => []);
    for (const n of names) {
      const m = /^([0-9a-f]{32})\.(rpl|err|rpl\.tmp)$/.exec(n);
      if (m && !keep.has(m[1]) && m[1] !== this.running) await fsp.unlink(path.join(this.cacheDir, n)).catch(() => {});
    }
  }

  start(intervalMs = 60 * 1000) {
    if (!this.enabled) return;
    const tick = () => this.scan().catch((e) => this.log.warn?.(`[replay] scan failed: ${e.message}`));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** Send a cached replay. The file is gzip, so it goes out as Content-Encoding: gzip and the browser unpacks it. */
export async function sendReplay(req, res, file) {
  const st = await fsp.stat(file);
  const etag = `"r${path.basename(file, '.rpl').slice(0, 16)}-${st.size.toString(16)}"`;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'gzip',
    'Cache-Control': 'public, max-age=300',
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
