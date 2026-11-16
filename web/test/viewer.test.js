import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import zlib from 'node:zlib';
import { demoPathFromViewerUrl, resolveViewerFile, viewerHref } from '../src/viewer.js';
import { ReplayCache, replayKey } from '../src/replays.js';

const ORIGIN = 'https://cs2.example.com';
const DEMO = '2026-11-16_20-00-00_5_de_nuke_A_vs_B.dem';

function fakeViewer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>viewer</title>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  fs.mkdirSync(path.join(dir, 'wasm'));
  fs.writeFileSync(path.join(dir, 'wasm', 'csdemoparser.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  fs.writeFileSync(path.join(dir, '.secret.js'), 'no');
  return dir;
}

// Stand-in for bin/replay: writes two frames ("a", "bc") as gzip, or fails on a demo containing "bad".
function fakeReplayBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replaybin-'));
  const bin = path.join(dir, 'replay');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const zlib = require('zlib');
const [demo, out] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, demo + '\\n');
if (fs.readFileSync(demo, 'utf8').includes('bad')) { console.error('{"level":"info"}'); console.error('could not read demo: broken'); process.exit(1); }
const frame = (s) => { const b = Buffer.alloc(4 + s.length); b.writeUInt32LE(s.length); b.write(s, 4); return b; };
fs.writeFileSync(out + '.tmp', zlib.gzipSync(Buffer.concat([frame('a'), frame('bc')])));
fs.renameSync(out + '.tmp', out);
`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : []) };
}

function writeOld(file, content) {
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(file, t, t);
}

async function startApp(env) {
  const demos = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  const config = loadConfig({
    PUBLIC_URL: 'http://localhost:8080', SESSION_SECRET: 'x'.repeat(32), DEMOS_DIR: demos, DATA_DIR: ':memory:',
    REPLAY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'replays-')), REPLAY_BIN: path.join(os.tmpdir(), 'no-such-replay-bin'),
    GAME_HOST: '127.0.0.1', GAME_PORT: '1', STEAM_GROUP_ID: '', ...env,
  });
  const quiet = { warn() {}, error() {}, log() {} };
  const handler = createApp({ config, store: openDb(':memory:'), log: quiet });
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, demos, replays: handler.replays, base: `http://127.0.0.1:${srv.address().port}` };
}

test('viewer: demo URL mapping only accepts our own demo files', () => {
  assert.equal(demoPathFromViewerUrl(`/demos/file/${DEMO}`, ORIGIN), DEMO);
  assert.equal(demoPathFromViewerUrl(`${ORIGIN}/demos/file/sub/${encodeURIComponent('a b.dem.gz')}`, ORIGIN), 'sub/a b.dem.gz');
  for (const bad of [
    'https://evil.example.com/demos/file/x.dem', 'http://cs2.example.com/demos/file/x.dem', '//evil.example.com/demos/file/x.dem',
    '/demos/file/x.zip', '/demos/file/x.dem?x=1', '/demos/x.dem', '/demos/file/%E0%A4%A.dem', 'javascript:alert(1)', '', null,
  ]) {
    assert.equal(demoPathFromViewerUrl(bad, ORIGIN), null, String(bad));
  }
  // Dot segments are normalised by URL parsing and then refused by resolveDemoPath, not here.
  assert.equal(viewerHref('sub/a b.dem'), '/viewer/player?demourl=%2Fdemos%2Ffile%2Fsub%2Fa%2520b.dem');
});

test('viewer: static file resolution', () => {
  assert.equal(resolveViewerFile('/v', '/viewer/player').abs, path.join('/v', 'index.html'));
  assert.equal(resolveViewerFile('/v', '/viewer/assets/a-1.js').immutable, true);
  assert.equal(resolveViewerFile('/v', '/viewer/wasm/csdemoparser.wasm').type, 'application/wasm');
  for (const bad of ['/viewer/../x.js', '/viewer/.env.js', '/viewer/assets//a.js', '/viewer/a.exe', '/viewer/a%2Fb.js', '/viewer/x']) {
    assert.equal(resolveViewerFile('/v', bad), null, bad);
  }
});

test('HTTP: viewer serves the bundle and server-parsed replays, linked from the demos page', async () => {
  const fake = fakeReplayBin();
  const { srv, base, demos, replays } = await startApp({ VIEWER_DIR: fakeViewer(), REPLAY_BIN: fake.bin });
  try {
    writeOld(path.join(demos, DEMO), 'demo-bytes');
    writeOld(path.join(demos, 'broken.dem'), 'bad');
    fs.writeFileSync(path.join(demos, 'recording.dem'), 'still being written');
    fs.writeFileSync(path.join(demos, 'old.zip'), 'zip');

    let r = await fetch(`${base}/demos`);
    const html = await r.text();
    assert.ok(html.includes(`href="/viewer/player?demourl=%2Fdemos%2Ffile%2F${DEMO}"`));
    assert.equal((html.match(/Watch 2D/g) || []).length, 3, 'no viewer link for .zip');
    assert.ok(html.includes('href="/viewer/"'), 'link to open your own demo');

    r = await fetch(`${base}/viewer`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    r = await fetch(`${base}/viewer/player?demourl=x`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
    assert.match(await r.text(), /viewer/);
    r = await fetch(`${base}/viewer/wasm/csdemoparser.wasm`);
    assert.equal(r.headers.get('content-type'), 'application/wasm');
    r = await fetch(`${base}/viewer/.secret.js`);
    assert.equal(r.status, 404);
    assert.equal((await fetch(`${base}/viewer/download?url=${encodeURIComponent(`/demos/file/${DEMO}`)}`)).status, 404, 'no raw demo feed');

    // First request queues the parse (202), then the replay is served gzip-encoded.
    const replayUrl = `${base}/viewer/replay?url=${encodeURIComponent(`/demos/file/${DEMO}`)}`;
    r = await fetch(replayUrl);
    assert.equal(r.status, 202);
    assert.equal((await r.json()).status, 'processing');
    await replays.idle();
    r = await fetch(replayUrl);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    const body = Buffer.from(await r.arrayBuffer()); // fetch undoes Content-Encoding: gzip
    assert.equal(body.readUInt32LE(0), 1);
    assert.equal(body.subarray(4, 5).toString(), 'a');
    r = await fetch(replayUrl, { headers: { 'If-None-Match': r.headers.get('etag') } });
    assert.equal(r.status, 304);

    r = await fetch(`${base}/viewer/replay?url=${encodeURIComponent('/demos/file/broken.dem')}`);
    assert.equal(r.status, 202);
    await replays.idle();
    r = await fetch(`${base}/viewer/replay?url=${encodeURIComponent('/demos/file/broken.dem')}`);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'could not read demo: broken');

    r = await fetch(`${base}/viewer/replay?url=${encodeURIComponent('/demos/file/recording.dem')}`);
    assert.equal(r.status, 409);

    for (const bad of ['https://evil.example.com/x.dem', '/demos/file/..%2F..%2Fetc%2Fpasswd.dem', '/demos/file/old.zip', '/demos/file/missing.dem']) {
      r = await fetch(`${base}/viewer/replay?url=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 404, bad);
    }
    assert.deepEqual(fake.calls().map((c) => path.basename(c)), [DEMO, 'broken.dem'], 'each demo parsed once');
  } finally { srv.close(); }
});

test('replay cache: background scan parses stable demos once and prunes stale cache files', async () => {
  const fake = fakeReplayBin();
  const demos = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replays-'));
  fs.mkdirSync(path.join(demos, 'sub'));
  writeOld(path.join(demos, 'a.dem'), 'aaa');
  writeOld(path.join(demos, 'sub', 'b.dem.gz'), 'bbb');
  writeOld(path.join(demos, 'c.zip'), 'zip');
  fs.writeFileSync(path.join(demos, 'live.dem'), 'recording');
  fs.writeFileSync(path.join(cacheDir, `${'f'.repeat(32)}.rpl`), 'stale');
  const quiet = { warn() {}, error() {}, log() {} };
  const cache = new ReplayCache({ demosDir: demos, cacheDir, bin: fake.bin, log: quiet });
  assert.equal(cache.enabled, true);
  await cache.scan();
  await cache.idle();
  assert.deepEqual(fake.calls().map((c) => path.relative(demos, c)).sort(), ['a.dem', path.join('sub', 'b.dem.gz')]);
  assert.ok(!fs.existsSync(path.join(cacheDir, `${'f'.repeat(32)}.rpl`)), 'stale cache file removed');
  const st = fs.statSync(path.join(demos, 'a.dem'));
  assert.equal((await cache.status(replayKey('a.dem', st.size, st.mtimeMs))).state, 'ready');
  await cache.scan();
  await cache.idle();
  assert.equal(fake.calls().length, 2, 'nothing parsed twice');
  assert.equal(new ReplayCache({ demosDir: demos, cacheDir, bin: '/nonexistent', log: quiet }).enabled, false);
  zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, `${replayKey('a.dem', st.size, st.mtimeMs)}.rpl`)));
});

test('HTTP: without the replay parser there are no Watch 2D links, but your own demo still works', async () => {
  const { srv, base, demos } = await startApp({ VIEWER_DIR: fakeViewer() });
  try {
    writeOld(path.join(demos, DEMO), 'demo-bytes');
    const html = await (await fetch(`${base}/demos`)).text();
    assert.ok(!html.includes('Watch 2D') && html.includes('href="/viewer/"'));
    assert.equal((await fetch(`${base}/viewer/replay?url=${encodeURIComponent(`/demos/file/${DEMO}`)}`)).status, 404);
  } finally { srv.close(); }
});

test('HTTP: without a viewer bundle there are no viewer links or routes', async () => {
  const { srv, base, demos } = await startApp({ VIEWER_DIR: path.join(os.tmpdir(), 'no-such-viewer') });
  try {
    fs.writeFileSync(path.join(demos, DEMO), 'demo-bytes');
    const html = await (await fetch(`${base}/demos`)).text();
    assert.ok(!html.includes('Watch 2D') && !html.includes('/viewer/'));
    assert.equal((await fetch(`${base}/viewer/player`)).status, 404);
  } finally { srv.close(); }
});
