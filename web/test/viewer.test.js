import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { demoPathFromViewerUrl, resolveViewerFile, viewerHref } from '../src/viewer.js';

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

async function startApp(env) {
  const demos = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  const config = loadConfig({
    PUBLIC_URL: 'http://localhost:8080', SESSION_SECRET: 'x'.repeat(32), DEMOS_DIR: demos, DATA_DIR: ':memory:',
    GAME_HOST: '127.0.0.1', GAME_PORT: '1', STEAM_GROUP_ID: '', ...env,
  });
  const quiet = { warn() {}, error() {}, log() {} };
  const srv = http.createServer(createApp({ config, store: openDb(':memory:'), log: quiet }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, demos, base: `http://127.0.0.1:${srv.address().port}` };
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

test('HTTP: viewer serves the bundle, feeds demos and is linked from the demos page', async () => {
  const { srv, base, demos } = await startApp({ VIEWER_DIR: fakeViewer() });
  try {
    fs.writeFileSync(path.join(demos, DEMO), 'demo-bytes');
    fs.writeFileSync(path.join(demos, 'old.zip'), 'zip');

    let r = await fetch(`${base}/demos`);
    const html = await r.text();
    assert.ok(html.includes(`href="/viewer/player?demourl=%2Fdemos%2Ffile%2F${DEMO}"`));
    assert.equal((html.match(/Watch 2D/g) || []).length, 1, 'no viewer link for .zip');

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

    r = await fetch(`${base}/viewer/download?url=${encodeURIComponent(`/demos/file/${DEMO}`)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-demo-length'), '10');
    assert.match(r.headers.get('content-disposition'), new RegExp(`filename="${DEMO}"`));
    assert.equal(await r.text(), 'demo-bytes');

    for (const bad of ['https://evil.example.com/x.dem', '/demos/file/..%2F..%2Fetc%2Fpasswd.dem', '/demos/file/old.zip', '/demos/file/missing.dem']) {
      r = await fetch(`${base}/viewer/download?url=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 404, bad);
    }
  } finally { srv.close(); }
});

test('HTTP: without a viewer bundle there are no viewer links or routes', async () => {
  const { srv, base, demos } = await startApp({ VIEWER_DIR: path.join(os.tmpdir(), 'no-such-viewer') });
  try {
    fs.writeFileSync(path.join(demos, DEMO), 'demo-bytes');
    const html = await (await fetch(`${base}/demos`)).text();
    assert.ok(!html.includes('Watch 2D'));
    assert.equal((await fetch(`${base}/viewer/player`)).status, 404);
  } finally { srv.close(); }
});
