import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp, parseBackupList, extractJson, parseDmStatus } from '../src/app.js';
import { applyEvent, buildDemoRows } from '../src/events.js';
import { buildMatchConfig, parseRoster, toSteamId64, quickScrimCommands } from '../src/matchconfig.js';
import { encodeSession, decodeSession, Sessions } from '../src/session.js';
import { PacketDecoder, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE, SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE } from '../src/rcon.js';

async function startApp(env = {}) {
  const demos = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  const config = loadConfig({
    PUBLIC_URL: 'http://localhost:8080', SESSION_SECRET: 'x'.repeat(32), MATCHZY_EVENTS_TOKEN: 'evtok',
    DEMOS_DIR: demos, DATA_DIR: ':memory:', GAME_HOST: '127.0.0.1', GAME_PORT: '1', STEAM_GROUP_ID: '',
    ...env,
  });
  const store = openDb(':memory:');
  const quiet = { warn() {}, error() {}, log() {} };
  const srv = http.createServer(createApp({ config, store, log: quiet }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, store, demos, config, base: `http://127.0.0.1:${srv.address().port}` };
}

test('SteamID conversions and roster parsing', () => {
  assert.equal(toSteamId64('STEAM_0:1:12345'), '76561197960290419');
  assert.equal(toSteamId64('[U:1:24691]'), '76561197960290419');
  assert.equal(toSteamId64('https://steamcommunity.com/profiles/76561197960290419/'), '76561197960290419');
  assert.equal(toSteamId64('bob'), null);
  const r = parseRoster('76561197960290419 Alice\n76561197960290420, 76561197960290421\nnope');
  assert.deepEqual(r.players, { '76561197960290419': 'Alice', '76561197960290420': '', '76561197960290421': '' });
  assert.equal(r.errors.length, 1);
});

test('match config: Bo3 veto with rosters', () => {
  const { config, errors, quick } = buildMatchConfig({
    team1: 'Alpha', team2: 'Bravo', team1_players: '76561197960290419', team2_players: '76561197960290420',
    team1_coaches: '76561197960290421', format: 'bo3', playout: '1', coaches: '1',
  }, { matchId: 42, mapPool: ['de_a', 'de_b', 'de_c', 'de_d', 'de_e', 'de_f', 'de_g'] });
  assert.deepEqual(errors, []);
  assert.equal(quick, false);
  assert.equal(config.matchid, 42);
  assert.equal(config.num_maps, 3);
  assert.equal(config.skip_veto, false);
  assert.equal(config.maplist.length, 7);
  assert.equal(config.players_per_team, 5);
  assert.ok('76561197960290421' in config.team1.players);
  assert.equal(config.cvars.matchzy_playout_enabled_default, 'false');
  assert.equal(config.cvars.mp_match_can_clinch, undefined);
  const off = buildMatchConfig({ team1: 'A', team2: 'B', team1_players: '76561197960290419', team2_players: '76561197960290420', format: 'map', map: 'de_nuke', playout: '0' }, { matchId: 1, mapPool: [] });
  assert.equal(off.config.cvars.mp_match_can_clinch, '1');
});

test('match config: quick scrim without rosters, single map only', () => {
  const ok = buildMatchConfig({ team1: 'A', team2: 'B', format: 'map', map: 'de_nuke' }, { matchId: 1, mapPool: [] });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.quick, true);
  assert.equal(ok.playout, true); // default ON
  assert.deepEqual(quickScrimCommands(ok).at(-1), 'css_map de_nuke');
  const four = buildMatchConfig({ team1: 'A', team2: 'B', format: 'map', map: 'de_nuke', players_per_team: '4', min_players_to_ready: '4' }, { matchId: 2, mapPool: [] });
  assert.ok(quickScrimCommands(four).includes('css_readyrequired 8'));
  const bad = buildMatchConfig({ team1: 'A', team2: 'B', format: 'bo1' }, { matchId: 1, mapPool: ['de_a', 'de_b'] });
  assert.ok(bad.errors.length);
  const half = buildMatchConfig({ team1: 'A', team2: 'B', format: 'map', map: 'de_nuke', team1_players: '76561197960290419' }, { matchId: 1, mapPool: [] });
  assert.ok(half.errors.some((e) => /both teams/.test(e)));
  const inj = buildMatchConfig({ team1: 'A"; quit', team2: 'B', format: 'map', map: 'de_nuke; quit' }, { matchId: 1, mapPool: [] });
  assert.ok(inj.errors.some((e) => /valid map/.test(e)));
  assert.equal(inj.config.team1.name, 'A quit');
});

test('session cookie signing', () => {
  const v = encodeSession('secret', { sid: '1', exp: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(decodeSession('secret', v).sid, '1');
  assert.equal(decodeSession('other', v), null);
  assert.equal(decodeSession('secret', v.replace(/^./, 'A')), null);
  const expired = encodeSession('secret', { sid: '1', exp: 1 });
  assert.equal(decodeSession('secret', expired), null);
});

test('backup list parsing and json extraction', () => {
  const items = parseBackupList('matchzy_17_0_round03.json 2026-11-16 Alpha Bravo de_nuke 2 1\n/x/csgo/MatchZyDataBackup/matchzy_17_0_round11.json\njunk');
  assert.deepEqual(items.map((i) => i.round), [11, 3]);
  assert.equal(items[1].info, '2026-11-16 Alpha Bravo de_nuke 2 1');
  assert.deepEqual(extractJson('L 11/16 [MatchZy] {"gamestate":"live","paused":false}\n'), { gamestate: 'live', paused: false });
});

test('events -> store -> demo rows', () => {
  const store = openDb(':memory:');
  store.saveConfig(500, 'x', { matchid: 500, maplist: ['de_nuke'], num_maps: 1, skip_veto: true });
  applyEvent(store, { event: 'series_start', matchid: 500, num_maps: 1, team1: { id: '', name: 'Alpha' }, team2: { id: '', name: 'Bravo' } });
  applyEvent(store, { event: 'going_live', matchid: 500, map_number: 0 });
  applyEvent(store, { event: 'round_end', matchid: 500, map_number: 0, round_number: 0, team1: { name: 'Alpha', score: 1 }, team2: { name: 'Bravo', score: 0 }, winner: { side: 'ct', team: 'team1' } });
  applyEvent(store, { event: 'map_result', matchid: 500, map_number: 0, team1: { name: 'Alpha', score: 16 }, team2: { name: 'Bravo', score: 14 }, winner: { side: 'ct', team: 'team1' } });
  applyEvent(store, { event: 'series_end', matchid: 500, team1_series_score: 1, team2_series_score: 0, winner: { side: 'ct', team: 'team1' }, time_until_restore: 0 });
  const rows = buildDemoRows(store, [
    { path: '2026-11-16_20-00-00_500_de_nuke_Alpha_vs_Bravo.dem', name: '2026-11-16_20-00-00_500_de_nuke_Alpha_vs_Bravo.dem', size: 10, mtime: 1 },
    { path: 'old.dem', name: 'old.dem', size: 5, mtime: 0 },
  ]);
  assert.equal(rows[0].score1, 16);
  assert.equal(rows[0].score2, 14);
  assert.equal(rows[0].winner, 'Alpha');
  assert.equal(rows[0].map, 'de_nuke');
  assert.equal(store.getSeries(500).winner, 'Alpha');
  assert.equal(rows[1].source, 'unknown');
});

test('HTTP: events endpoint requires token', async () => {
  const { srv, base, store } = await startApp();
  try {
    let r = await fetch(`${base}/api/matchzy/events`, { method: 'POST', body: '{"event":"series_start","matchid":1}' });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/matchzy/events`, { method: 'POST', headers: { 'X-Events-Token': 'wrong' }, body: '{}' });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/matchzy/events`, {
      method: 'POST', headers: { 'X-Events-Token': 'evtok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'series_start', matchid: 9, num_maps: 1, team1: { name: 'A' }, team2: { name: 'B' } }),
    });
    assert.equal(r.status, 200);
    assert.equal(store.getSeries(9).team1, 'A');
  } finally { srv.close(); }
});

test('HTTP: match config requires token; demos download with traversal protection', async () => {
  const { srv, base, store, demos } = await startApp();
  try {
    store.saveConfig(77, 'x', { matchid: 77 });
    let r = await fetch(`${base}/api/matchconfig/77.json`);
    assert.equal(r.status, 401);

    fs.writeFileSync(path.join(demos, '2026-11-16_20-00-00_5_de_nuke_A_vs_B.dem'), 'demo-bytes');
    r = await fetch(`${base}/demos`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Nuke/);
    assert.match(html, /\/demos\/file\/2026-11-16_20-00-00_5_de_nuke_A_vs_B\.dem/);

    r = await fetch(`${base}/demos/file/2026-11-16_20-00-00_5_de_nuke_A_vs_B.dem`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), 'demo');

    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e/x.dem', '..%5C..%5Cx.dem', 'x.dem%00']) {
      r = await fetch(`${base}/demos/file/${bad}`);
      assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
    }
  } finally { srv.close(); }
});

test('HTTP: admin action without session/CSRF is refused', async () => {
  const { srv, base } = await startApp();
  try {
    const r = await fetch(`${base}/admin/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=practice',
    });
    assert.equal(r.status, 401);
    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Sign in through Steam/);
  } finally { srv.close(); }
});

test('HTTP: logged-in non-member is refused; member without CSRF is refused', async () => {
  const { srv, base } = await startApp({ ADMIN_STEAM_IDS: '76561197960290419' });
  try {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const cookieFor = (sid) => `cs2panel=${encodeURIComponent(encodeSession('x'.repeat(32), { sid, name: 'n', exp, n: 'abc' }))}`;
    let r = await fetch(`${base}/admin/action`, {
      method: 'POST', headers: { Cookie: cookieFor('76561197960290420'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=practice',
    });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/admin/action`, {
      method: 'POST', headers: { Cookie: cookieFor('76561197960290419'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=practice&csrf=bad',
    });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /CSRF/);
  } finally { srv.close(); }
});

test('deathmatch status parsing', () => {
  assert.deepEqual(parseDmStatus('[DM] x\ndeathmatch=on variant=team\n'), { on: true, variant: 'team' });
  assert.deepEqual(parseDmStatus('deathmatch=off variant=ffa'), { on: false, variant: 'ffa' });
  assert.deepEqual(parseDmStatus('deathmatch=on variant=gg'), { on: true, variant: 'gg' });
  assert.equal(parseDmStatus('Unknown command "css_dm_status"'), null);
  assert.equal(parseDmStatus(undefined), null);
});

/** Minimal fake CS2 RCON: css_dm turns deathmatch on unless a match is "running"; css_dm_status reports it. */
function fakeDmRcon({ matchRunning = false } = {}) {
  const state = { on: false, variant: 'ffa', commands: [] };
  const srv = net.createServer((sock) => {
    const d = new PacketDecoder();
    sock.on('data', (chunk) => {
      for (const p of d.push(chunk)) {
        if (p.type === SERVERDATA_AUTH) {
          sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
          sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
        } else if (p.type === SERVERDATA_EXECCOMMAND) {
          state.commands.push(p.body);
          let out = '';
          const m = /^css_dm (ffa|team|gg)$/.exec(p.body);
          if (m) {
            out = `[DM] Starting ${m[1]} deathmatch...`;
            if (!matchRunning) { state.on = true; state.variant = m[1]; }
          } else if (p.body === 'css_dm_status') out = `deathmatch=${state.on ? 'on' : 'off'} variant=${state.variant}`;
          sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, out));
        } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
          sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
          sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001'));
        }
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state })));
}

async function dmAction(action, { matchRunning = false } = {}) {
  const rconSrv = await fakeDmRcon({ matchRunning });
  const secret = 'x'.repeat(32);
  const config = loadConfig({
    PUBLIC_URL: 'http://localhost:8080', SESSION_SECRET: secret, MATCHZY_EVENTS_TOKEN: 'evtok',
    DEMOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'demos-')), DATA_DIR: ':memory:', GAME_HOST: '127.0.0.1', GAME_PORT: '1',
    STEAM_GROUP_ID: '', ADMIN_STEAM_IDS: '76561197960290419',
    RCON_HOST: '127.0.0.1', RCON_PORT: String(rconSrv.srv.address().port), RCON_PASSWORD: 'pw',
  });
  config.dmCheckDelayMs = 10;
  const quiet = { warn() {}, error() {}, log() {} };
  const srv = http.createServer(createApp({ config, store: openDb(':memory:'), log: quiet }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const session = { sid: '76561197960290419', name: 'n', exp: Math.floor(Date.now() / 1000) + 600, n: 'abc' };
    const csrf = new Sessions({ secret }).csrfToken(session);
    const cookie = `cs2panel=${encodeURIComponent(encodeSession(secret, session))}`;
    const r = await fetch(`${base}/admin/action`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `action=${action}&csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(r.status, 303);
    const html = await (await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).text();
    return { html, state: rconSrv.state };
  } finally { srv.close(); rconSrv.srv.close(); }
}

test('HTTP: deathmatch buttons start deathmatch over RCON and report the result', async () => {
  let { html, state } = await dmAction('deathmatch');
  assert.deepEqual(state.commands.slice(0, 2), ['css_dm ffa', 'css_dm_status']);
  assert.equal(state.on, true);
  assert.match(html, /deathmatch( \(free for all\))? is on/i);
  assert.match(html, /Team deathmatch/); // the card's button

  ({ html, state } = await dmAction('deathmatch_team'));
  assert.equal(state.variant, 'team');
  assert.match(html, /deathmatch( \(free for all\))? is on/i);

  ({ html, state } = await dmAction('gungame'));
  assert.equal(state.variant, 'gg');
  assert.match(html, /Gun game is on/);

  ({ html, state } = await dmAction('deathmatch', { matchRunning: true }));
  assert.equal(state.on, false);
  assert.match(html, /did not start/);
});
