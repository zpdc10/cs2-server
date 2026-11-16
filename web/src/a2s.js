// A2S_INFO query (https://developer.valvesoftware.com/wiki/Server_queries#A2S_INFO), with challenge support.

import dgram from 'node:dgram';

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQUEST = Buffer.concat([HEADER, Buffer.from([0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);

export function parseInfo(buf) {
  let o = 0;
  if (buf.readInt32LE(0) !== -1) throw new Error('A2S: split packets not supported');
  o = 4;
  const kind = buf[o++];
  if (kind !== 0x49) throw new Error(`A2S: unexpected response 0x${kind.toString(16)}`);
  const str = () => {
    const end = buf.indexOf(0, o);
    if (end === -1) throw new Error('A2S: truncated string');
    const s = buf.toString('utf8', o, end);
    o = end + 1;
    return s;
  };
  const protocol = buf[o++];
  const name = str();
  const map = str();
  const folder = str();
  const game = str();
  const appId = buf.readUInt16LE(o); o += 2;
  const players = buf[o++];
  const maxPlayers = buf[o++];
  const bots = buf[o++];
  const serverType = String.fromCharCode(buf[o++]);
  const environment = String.fromCharCode(buf[o++]);
  const visibility = buf[o++];
  const vac = buf[o++];
  const version = o < buf.length ? str() : '';
  return {
    protocol, name, map, folder, game, appId, players, maxPlayers, bots,
    serverType, environment, passworded: visibility === 1, vac: vac === 1, version,
  };
}

export function queryInfo(host, port, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('A2S: timeout')), timeoutMs);
    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      try {
        if (msg.length >= 9 && msg.readInt32LE(0) === -1 && msg[4] === 0x41) {
          // challenge: resend request with challenge appended
          sock.send(Buffer.concat([INFO_REQUEST, msg.subarray(5, 9)]), port, host);
          return;
        }
        finish(null, parseInfo(msg));
      } catch (e) {
        finish(e);
      }
    });
    sock.send(INFO_REQUEST, port, host, (err) => { if (err) finish(err); });
  });
}
