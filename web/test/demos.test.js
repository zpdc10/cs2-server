import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  parseDemoFilename, resolveDemoPath, isInsideRealRoot, parseRange, sendFile, listDemoFiles,
} from '../src/demos.js';

test('parse default MatchZy demo name', () => {
  assert.deepEqual(parseDemoFilename('2026-11-16_20-05-33_1763323533_de_mirage_Team_Alpha_vs_Bravo_Five.dem'), {
    date: '2026-11-16T20:05:33', matchId: 1763323533, map: 'de_mirage', team1: 'Team Alpha', team2: 'Bravo Five',
  });
});

test('parse map names with underscores and workshop ids', () => {
  assert.equal(parseDemoFilename('2026-01-02_03-04-05_12_de_ancient_night_A_vs_B.dem').map, 'de_ancient_night');
  assert.equal(parseDemoFilename('2026-01-02_03-04-05_12_de_somecustom_A_vs_B.dem').map, 'de_somecustom');
  const w = parseDemoFilename('2026-01-02_03-04-05_12_3070284539_A_vs_B.dem');
  assert.equal(w.map, '3070284539');
  assert.equal(w.team1, 'A');
});

test('parse default team names and zip', () => {
  const p = parseDemoFilename('2026-01-02_03-04-05_-1_de_dust2_COUNTER-TERRORISTS_vs_TERRORISTS.dem.zip');
  assert.equal(p.matchId, -1);
  assert.equal(p.team1, 'COUNTER-TERRORISTS');
  assert.equal(p.team2, 'TERRORISTS');
});

test('unknown names return null', () => {
  assert.equal(parseDemoFilename('random_demo.dem'), null);
  assert.equal(parseDemoFilename('auto0-20260101-000000-de_dust2.dem'), null);
});

test('path traversal guard', () => {
  const root = '/data/demos';
  assert.equal(resolveDemoPath(root, 'a.dem'), '/data/demos/a.dem');
  assert.equal(resolveDemoPath(root, 'sub/a.dem'), '/data/demos/sub/a.dem');
  for (const bad of ['../a.dem', 'sub/../../a.dem', '/etc/passwd.dem', '..', 'a/./b.dem', '.hidden.dem',
    'sub//a.dem', 'a.dem\0.txt', 'C:/x.dem', 'sub\\..\\a.dem', '../../etc/passwd', 'a.txt', '', 'x/..%2f.dem'.replace('%2f', '/')]) {
    assert.equal(resolveDemoPath(root, bad), null, bad);
  }
});

test('symlink escaping the root is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.dem'), 'x');
  fs.symlinkSync(path.join(outside, 'secret.dem'), path.join(dir, 'link.dem'));
  fs.writeFileSync(path.join(dir, 'ok.dem'), 'y');
  assert.equal(await isInsideRealRoot(dir, path.join(dir, 'link.dem')), false);
  assert.equal(await isInsideRealRoot(dir, path.join(dir, 'ok.dem')), true);
});

test('range parsing', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-1000', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange('bytes=9-2', 100), null);
});

test('sendFile: full, ranged, HEAD and 416', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  const file = path.join(dir, 'x.dem');
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  fs.writeFileSync(file, data);
  const srv = http.createServer((req, res) => sendFile(req, res, file));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  try {
    let r = await fetch(base);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '1000');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="x.dem"/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data);

    r = await fetch(base, { headers: { Range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
    assert.equal(r.headers.get('content-length'), '10');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(10, 20));

    r = await fetch(base, { headers: { Range: 'bytes=5000-' } });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */1000');

    r = await fetch(base, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '1000');
  } finally {
    srv.close();
  }
});

test('listDemoFiles finds demos in root and one subdirectory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  fs.writeFileSync(path.join(dir, 'a.dem'), 'a');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.dem'), 'bb');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const files = (await listDemoFiles(dir)).map((f) => f.path).sort();
  assert.deepEqual(files, ['a.dem', 'sub/b.dem']);
});
