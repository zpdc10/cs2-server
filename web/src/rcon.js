// Minimal Source RCON client (https://developer.valvesoftware.com/wiki/Source_RCON_Protocol).
// Packet: int32 size | int32 id | int32 type | body (ASCII/UTF-8) \0 | \0   (little endian; size excludes itself)

import net from 'node:net';

export const SERVERDATA_AUTH = 3;
export const SERVERDATA_AUTH_RESPONSE = 2;
export const SERVERDATA_EXECCOMMAND = 2;
export const SERVERDATA_RESPONSE_VALUE = 0;

const MAX_PACKET_SIZE = 4096 + 10; // body is at most 4096 bytes per Valve docs; be lenient below
const HARD_MAX_SIZE = 1024 * 1024; // refuse absurd sizes (corrupt stream)

export function encodePacket(id, type, body = '') {
  const bodyBuf = Buffer.from(body, 'utf8');
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // two trailing NUL bytes already zero from alloc
  return buf;
}

/**
 * Streaming decoder: feed arbitrary chunks, get complete packets back.
 * Handles packets split across chunks and several packets in one chunk.
 */
export class PacketDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const packets = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (size < 10 || size > HARD_MAX_SIZE) {
        throw new Error(`RCON: invalid packet size ${size}`);
      }
      if (this.buffer.length < 4 + size) break;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      // body ends at the first NUL (or at size-2 terminators)
      let end = 12 + size - 10;
      const nul = this.buffer.indexOf(0, 12);
      if (nul !== -1 && nul < end) end = nul;
      const body = this.buffer.toString('utf8', 12, end);
      packets.push({ id, type, body, size });
      this.buffer = this.buffer.subarray(4 + size);
    }
    return packets;
  }
}

export function decodePackets(buf) {
  return new PacketDecoder().push(buf);
}

export { MAX_PACKET_SIZE };

/**
 * Run one or more commands on a fresh, authenticated connection.
 * Multi-packet responses are collected until a terminator packet comes back:
 * after each command we send an empty SERVERDATA_RESPONSE_VALUE packet, which
 * Source servers mirror back after the full response. As a fallback (some
 * Source 2 builds don't mirror), a response is also considered complete after
 * `idleMs` of silence once data has arrived, `firstDataMs` without any data
 * (commands that print nothing), or `timeoutMs` overall.
 */
export async function rconExec(commands, {
  host, port, password, timeoutMs = 8000, idleMs = 400, firstDataMs = 2500, connectTimeoutMs = 4000,
} = {}) {
  if (!password) throw new Error('RCON_PASSWORD is not configured');
  const cmds = Array.isArray(commands) ? commands : [commands];
  for (const c of cmds) {
    if (typeof c !== 'string' || /[\r\n\0]/.test(c)) throw new Error('RCON: invalid command');
    if (Buffer.byteLength(c) > 4000) throw new Error('RCON: command too long');
  }

  const socket = net.createConnection({ host, port });
  socket.setNoDelay(true);
  const decoder = new PacketDecoder();
  let waiter = null; // { onPacket, onError }
  const queue = [];
  let fatal = null;

  const fail = (err) => {
    fatal = fatal || err;
    if (waiter) waiter.onError(fatal);
  };
  socket.on('data', (chunk) => {
    let pkts;
    try {
      pkts = decoder.push(chunk);
    } catch (e) {
      fail(e);
      socket.destroy();
      return;
    }
    for (const p of pkts) {
      if (waiter) waiter.onPacket(p);
      else queue.push(p);
    }
  });
  socket.on('error', (e) => fail(e));
  socket.on('close', () => fail(new Error('RCON: connection closed')));

  const next = (ms) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    if (fatal) return reject(fatal);
    const t = setTimeout(() => {
      waiter = null;
      resolve(null); // timeout
    }, ms);
    waiter = {
      onPacket: (p) => { clearTimeout(t); waiter = null; resolve(p); },
      onError: (e) => { clearTimeout(t); waiter = null; reject(e); },
    };
  });

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('RCON: connect timeout')), connectTimeoutMs);
      socket.once('connect', () => { clearTimeout(t); resolve(); });
      socket.once('error', (e) => { clearTimeout(t); reject(e); });
    });

    let nextId = 1000 + Math.floor(Math.random() * 1000);
    const authId = nextId++;
    socket.write(encodePacket(authId, SERVERDATA_AUTH, password));
    // Server may send an empty RESPONSE_VALUE before the AUTH_RESPONSE.
    const authDeadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await next(Math.max(1, authDeadline - Date.now()));
      if (!p) throw new Error('RCON: auth timeout');
      if (p.type === SERVERDATA_AUTH_RESPONSE) {
        if (p.id === -1) throw new Error('RCON: authentication failed (wrong RCON_PASSWORD?)');
        if (p.id === authId) break;
      }
    }

    const results = [];
    for (const cmd of cmds) {
      const cmdId = nextId++;
      const termId = nextId++;
      socket.write(encodePacket(cmdId, SERVERDATA_EXECCOMMAND, cmd));
      socket.write(encodePacket(termId, SERVERDATA_RESPONSE_VALUE, ''));
      let out = '';
      let gotData = false;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const p = await next(Math.min(gotData ? idleMs : firstDataMs, remaining));
        if (!p) break; // idle or overall timeout
        if (p.id === termId && p.type === SERVERDATA_RESPONSE_VALUE && p.body !== '' && !/^\x00\x01(\x00\x00)?$/.test(p.body)) {
          // CS2 tags the command's output with the id of the empty packet sent after it,
          // then follows with an empty packet carrying that same id. Keep the output.
          out += p.body;
          gotData = true;
          continue;
        }
        if (p.id === termId) {
          // Mirror of the terminator; Source also sends a second packet with
          // body "\x00\x01\x00\x00" - swallow it briefly if present.
          const extra = await next(50);
          if (extra && extra.id !== termId) queue.unshift(extra);
          break;
        }
        if (p.id === cmdId && p.type === SERVERDATA_RESPONSE_VALUE) {
          out += p.body;
          gotData = true;
        }
      }
      results.push(out);
    }
    return results;
  } finally {
    socket.destroy();
  }
}

/** Serialises RCON usage so concurrent panel clicks don't interleave. */
export class RconClient {
  constructor({ host, port, password }) {
    this.opts = { host, port, password };
    this.chain = Promise.resolve();
  }

  exec(commands, extra = {}) {
    const run = () => rconExec(commands, { ...this.opts, ...extra });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async one(command, extra) {
    const [out] = await this.exec([command], extra);
    return out;
  }
}

/** Remove characters that would let user input break out of a quoted console argument. */
export function sanitizeArg(s, maxLen = 120) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f"';\\]/g, '')
    .replace(/\/{2,}/g, '/ /') // "//" starts a comment in the CS2 console
    .trim()
    .slice(0, maxLen);
}
