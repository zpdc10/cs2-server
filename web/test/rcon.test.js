import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  encodePacket, decodePackets, PacketDecoder, rconExec, sanitizeArg,
  SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE, SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rcon.js';

test('encodePacket layout', () => {
  const b = encodePacket(7, SERVERDATA_EXECCOMMAND, 'status');
  assert.equal(b.length, 4 + 4 + 4 + 6 + 2);
  assert.equal(b.readInt32LE(0), b.length - 4);
  assert.equal(b.readInt32LE(4), 7);
  assert.equal(b.readInt32LE(8), 2);
  assert.equal(b.toString('ascii', 12, 18), 'status');
  assert.equal(b[18], 0);
  assert.equal(b[19], 0);
});

test('empty body packet is 10 bytes of payload', () => {
  const b = encodePacket(1, SERVERDATA_RESPONSE_VALUE, '');
  assert.equal(b.readInt32LE(0), 10);
  assert.equal(b.length, 14);
});

test('decode round trip, several packets in one buffer', () => {
  const buf = Buffer.concat([encodePacket(1, 0, 'hello'), encodePacket(2, 2, ''), encodePacket(-1, 2, 'x')]);
  const pkts = decodePackets(buf);
  assert.deepEqual(pkts.map((p) => [p.id, p.type, p.body]), [[1, 0, 'hello'], [2, 2, ''], [-1, 2, 'x']]);
});

test('decoder handles packets split at every byte', () => {
  const buf = Buffer.concat([encodePacket(5, 0, 'a'.repeat(5000)), encodePacket(6, 0, 'tail')]);
  const d = new PacketDecoder();
  const got = [];
  for (let i = 0; i < buf.length; i++) got.push(...d.push(buf.subarray(i, i + 1)));
  assert.equal(got.length, 2);
  assert.equal(got[0].body.length, 5000);
  assert.equal(got[1].body, 'tail');
});

test('decoder rejects corrupt size', () => {
  const b = Buffer.alloc(14);
  b.writeInt32LE(3, 0);
  assert.throws(() => decodePackets(b), /invalid packet size/);
});

test('utf8 bodies', () => {
  const [p] = decodePackets(encodePacket(1, 0, 'Spieler äöü 🎯'));
  assert.equal(p.body, 'Spieler äöü 🎯');
});

test('sanitizeArg strips quotes, semicolons and control chars', () => {
  assert.equal(sanitizeArg('hi"; quit; say "x\n'), 'hi quit say x');
});

/** Fake Source RCON server: splits long output across packets, mirrors terminator packets. */
function fakeServer({ password = 'pw', mirror = true, cs2 = false, output = (cmd) => `ran ${cmd}` } = {}) {
  const srv = net.createServer((sock) => {
    const d = new PacketDecoder();
    let pending = null;
    sock.on('data', (chunk) => {
      for (const p of d.push(chunk)) {
        if (p.type === SERVERDATA_AUTH) {
          sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
          sock.write(encodePacket(p.body === password ? p.id : -1, SERVERDATA_AUTH_RESPONSE, ''));
        } else if (cs2 && p.type === SERVERDATA_EXECCOMMAND) {
          pending = output(p.body);
        } else if (cs2 && p.type === SERVERDATA_RESPONSE_VALUE) {
          // CS2 behaviour seen live: output carries the terminator's id, then an empty packet with it.
          setTimeout(() => {
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, pending ?? ''));
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
            pending = null;
          }, 20);
        } else if (p.type === SERVERDATA_EXECCOMMAND) {
          const out = output(p.body);
          // send in 4000-char packets, and write them byte-chunked to stress the decoder
          const all = [];
          for (let i = 0; i < out.length; i += 4000) all.push(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, out.slice(i, i + 4000)));
          const buf = Buffer.concat(all);
          sock.write(buf.subarray(0, 7));
          setTimeout(() => sock.write(buf.subarray(7)), 20);
        } else if (p.type === SERVERDATA_RESPONSE_VALUE && mirror) {
          setTimeout(() => {
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001'));
          }, 40);
        }
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('rconExec: auth + multi-packet response with terminator', async () => {
  const big = 'x'.repeat(9000);
  const srv = await fakeServer({ output: (c) => (c === 'big' ? big : `ran ${c}`) });
  try {
    const res = await rconExec(['status', 'big', 'echo'], { host: '127.0.0.1', port: srv.address().port, password: 'pw' });
    assert.deepEqual(res, ['ran status', big, 'ran echo']);
  } finally { srv.close(); }
});

test('rconExec: CS2 tags output with the terminator id', async () => {
  const srv = await fakeServer({ cs2: true, output: (c) => (c === 'sv_cheats' ? 'sv_cheats = false' : `ran ${c}`) });
  try {
    const res = await rconExec(['sv_cheats', 'status'], { host: '127.0.0.1', port: srv.address().port, password: 'pw' });
    assert.deepEqual(res, ['sv_cheats = false', 'ran status']);
  } finally { srv.close(); }
});

test('rconExec: works without terminator mirroring (idle timeout)', async () => {
  const srv = await fakeServer({ mirror: false });
  try {
    const res = await rconExec('status', { host: '127.0.0.1', port: srv.address().port, password: 'pw', idleMs: 100, firstDataMs: 500 });
    assert.deepEqual(res, ['ran status']);
  } finally { srv.close(); }
});

test('rconExec: wrong password', async () => {
  const srv = await fakeServer();
  try {
    await assert.rejects(rconExec('status', { host: '127.0.0.1', port: srv.address().port, password: 'nope' }), /authentication failed/);
  } finally { srv.close(); }
});

test('rconExec: refuses newline injection', async () => {
  await assert.rejects(rconExec('say hi\nquit', { host: '127.0.0.1', port: 1, password: 'pw' }), /invalid command/);
});
