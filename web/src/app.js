// HTTP application: routing, auth, admin actions, public pages and APIs.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { queryInfo } from './a2s.js';
import {
  buildDemoRows, applyEvent,
} from './events.js';
import {
  listDemoFiles, resolveDemoPath, isInsideRealRoot, sendFile,
} from './demos.js';
import {
  VIEWER_CSP, viewerAvailable, demoPathFromViewerUrl, resolveViewerFile, sendViewerFile,
} from './viewer.js';
import { ReplayCache, sendReplay } from './replays.js';
import {
  buildMatchConfig, quickScrimCommands, quickScrimNote, isValidMapName,
} from './matchconfig.js';
import { buildAuthUrl, verifyAssertion } from './openid.js';
import { RconClient, sanitizeArg } from './rcon.js';
import { Sessions, safeEqual, sign } from './session.js';
import { SteamGroup, fetchPersonaName } from './steam.js';
import {
  layout, statusCard, demosTable, adminPage, messagePage, esc,
} from './views.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readForm(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Expected a form');
  const body = await readBody(req, 64 * 1024);
  return Object.fromEntries(new URLSearchParams(body.toString('utf8')));
}

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...headers });
}

function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location, 'Content-Length': 0 });
  res.end();
}

/** Extract the first JSON object from console output (replies may carry prefixes/log lines). */
export function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const DM_TITLES = { ffa: 'Deathmatch (free for all)', team: 'Team deathmatch', gg: 'Gun game' };

/** Parses the DeathmatchMode plugin's css_dm_status reply ("deathmatch=on variant=ffa"); null if the plugin did not answer. */
export function parseDmStatus(text) {
  const m = /deathmatch=(on|off)\s+variant=(ffa|team|gg)/.exec(String(text || ''));
  return m ? { on: m[1] === 'on', variant: m[2] } : null;
}

/** Parse `matchzy_listbackups` output into backup entries. */
export function parseBackupList(text) {
  const items = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /(matchzy_(\d+)_(\d+)_round(\d+)\.json)/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const info = line.slice(line.indexOf(m[1]) + m[1].length).trim();
    items.push({ file: m[1], matchid: Number(m[2]), mapNumber: Number(m[3]), round: Number(m[4]), info });
  }
  items.sort((a, b) => b.matchid - a.matchid || b.mapNumber - a.mapNumber || b.round - a.round);
  return items;
}

export function createApp({ config, store, log = console, fetchImpl = fetch }) {
  const sessions = new Sessions({ secret: config.sessionSecret, secure: config.secure, maxAgeSec: config.sessionMaxAgeSec });
  const group = new SteamGroup({ groupId: config.steamGroupId, cacheSec: config.groupCacheSec, fetchImpl, log });
  const rcon = new RconClient({ host: config.rconHost, port: config.rconPort, password: config.rconPassword });
  const configToken = sign(config.sessionSecret, 'matchconfig-token').slice(0, 32);
  const callbackPath = '/auth/steam/callback';
  const flashes = new Map(); // session nonce -> flash (one-shot)
  // MatchZy reports no "practice" state (gamestate is none/warmup), so remember what the panel last set.
  let panelMode = null;
  const dmCheckDelayMs = config.dmCheckDelayMs ?? 2500;
  const viewerEnabled = viewerAvailable(config.viewerDir);
  if (!viewerEnabled) log.log?.(`[web] 2D viewer not found in ${config.viewerDir}; Watch 2D links are hidden`);
  // Demos on the server are parsed here once (see replays.js); the browser only parses a visitor's own file.
  const replays = new ReplayCache({
    demosDir: config.demosDir, cacheDir: config.replayDir, bin: config.replayBin, threads: config.replayThreads, log,
  });
  const serverReplays = viewerEnabled && replays.enabled;
  if (viewerEnabled && !serverReplays) log.log?.(`[web] replay parser not found at ${config.replayBin}; Watch 2D links are hidden`);

  // ---- cached server status -------------------------------------------------
  let statusCache = { at: 0, value: null, pending: null };
  async function getStatus() {
    if (Date.now() - statusCache.at < 10000 && statusCache.value) return statusCache.value;
    if (statusCache.pending) return statusCache.pending;
    statusCache.pending = (async () => {
      let value;
      try {
        const info = await queryInfo(config.gameHost, config.gamePort, 2000);
        value = {
          online: true, name: info.name, map: info.map, players: info.players - info.bots,
          bots: info.bots, maxPlayers: info.maxPlayers, passworded: info.passworded,
        };
      } catch (e) {
        value = { online: false, error: e.message };
      }
      if (value.online && config.rconPassword) {
        try {
          const g5 = extractJson(await rcon.one('get5_status', { timeoutMs: 3000 }));
          // Deathmatch runs in MatchZy's sleep mode, which get5_status reports as "none".
          const dm = g5?.gamestate === 'none' ? await dmStatus() : null;
          if (g5?.gamestate) value.mode = modeLabel(g5, dm);
        } catch { /* RCON optional for public status */ }
      }
      statusCache = { at: Date.now(), value, pending: null };
      return value;
    })();
    return statusCache.pending;
  }

  async function dmStatus() {
    return parseDmStatus(await rcon.one('css_dm_status', { timeoutMs: 3000 }).catch(() => ''));
  }

  function modeLabel(g5, dm = null) {
    if (dm?.on) return DM_TITLES[dm.variant] || 'Deathmatch';
    const map = {
      none: 'Practice / idle', pre_veto: 'Waiting for veto', veto: 'Map veto', warmup: 'Warmup (ready up)',
      knife: 'Knife round', waiting_for_knife_decision: 'Knife decision', going_live: 'Going live',
      live: 'Live match', pending_restore: 'Restoring', post_game: 'Post game',
    };
    let label = map[g5.gamestate] || g5.gamestate;
    if (g5.gamestate === 'none' || g5.gamestate === 'warmup') {
      if (panelMode === 'practice') label = 'Practice';
      else if (g5.gamestate === 'none') label = 'Idle';
    }
    return label + (g5.paused ? ' (paused)' : '');
  }

  // ---- auth helpers ---------------------------------------------------------
  async function currentUser(req) {
    const s = sessions.read(req);
    if (!s) return { session: null, member: false };
    let member = config.adminSteamIds.has(s.sid);
    let groupError = null;
    if (!member && config.steamGroupId) {
      try {
        member = await group.isMember(s.sid);
      } catch (e) {
        groupError = e.message;
      }
    }
    return { session: s, member, groupError };
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && origin !== config.publicOrigin) return false;
    if (!origin && req.headers.referer) {
      try {
        if (new URL(req.headers.referer).origin !== config.publicOrigin) return false;
      } catch { return false; }
    }
    return true;
  }

  function page(res, opts, status = 200) {
    const csrf = opts.session ? sessions.csrfToken(opts.session) : '';
    send(res, status, layout({ ...opts, user: opts.session, csrf }), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
  }

  // ---- RCON-backed actions --------------------------------------------------
  async function runAction(action, form, user) {
    const out = (title, output, ok = true, message = '') => ({ title, output, ok, message });
    const exec = async (cmds) => (await rcon.exec(cmds)).map((o, i) => `> ${cmds[i].replace(/("X-Config-Token" )"[^"]*"/, '$1"***"')}\n${o.trim()}`).join('\n\n');

    switch (action) {
      case 'deathmatch':
      case 'deathmatch_team':
      case 'gungame': {
        const variant = { deathmatch: 'ffa', deathmatch_team: 'team', gungame: 'gg' }[action];
        const title = DM_TITLES[variant];
        const o = await exec([`css_dm ${variant}`]);
        // The switch runs through MatchZy's cfgs; give the server a moment, then ask the plugin whether it is on.
        await new Promise((r) => setTimeout(r, dmCheckDelayMs));
        const dm = await dmStatus();
        statusCache.at = 0;
        if (dm?.on && dm.variant === variant) {
          panelMode = null;
          return out(title, o, true, `${title} is on. Switch to practice or exit to match mode to leave it.`);
        }
        return out(title, o, false, dm
          ? `${title} did not start (yet). If a match is running, cancel it first; otherwise refresh in a few seconds.`
          : 'The server did not answer css_dm_status. Is the DeathmatchMode plugin loaded?');
      }
      case 'practice': {
        const o = await exec(['css_prac']);
        if (!/cannot|started/i.test(o)) panelMode = 'practice';
        return out('Practice mode', o);
      }
      case 'exitprac':
        panelMode = 'match';
        return out('Exit practice', await exec(['css_exitprac']));
      case 'pause':
        return out('Pause', await exec(['css_forcepause']));
      case 'unpause':
        return out('Unpause', await exec(['css_forceunpause']));
      case 'forcestart':
        return out('Force start', await exec(['css_start']));
      case 'endmatch':
        return out('Match cancelled', await exec(['css_endmatch']));
      case 'endmatch_team1':
        return out('Match ended (team1 wins)', await exec(['css_endmatch team1']));
      case 'endmatch_team2':
        return out('Match ended (team2 wins)', await exec(['css_endmatch team2']));
      case 'say': {
        const msg = sanitizeArg(form.message, 200);
        if (!msg) return out('Say', '', false, 'Empty message.');
        return out('Message sent', await exec([`css_asay ${msg}`]));
      }
      case 'changemap': {
        const map = String(form.custom_map || form.map || '').trim().toLowerCase();
        if (!isValidMapName(map)) return out('Change map', '', false, 'Invalid map name.');
        return out(`Changing map to ${map}`, await exec([`css_map ${map}`]));
      }
      case 'restore': {
        const file = String(form.file || '');
        if (!/^matchzy_\d+_\d+_round\d+\.json$/.test(file)) return out('Restore', '', false, 'Invalid backup file.');
        return out(`Restoring ${file}`, await exec([`matchzy_loadbackup ${file}`]));
      }
      case 'scrim':
        return startScrim(form, user, exec, out);
      default:
        return out('Unknown action', '', false);
    }
  }

  async function startScrim(form, user, exec, out) {
    panelMode = 'match';
    const matchId = store.newMatchId();
    const built = buildMatchConfig(form, { matchId, mapPool: config.mapPool });
    if (built.errors.length) return out('Scrim not started', '', false, built.errors.join(' '));
    const { config: cfg } = built;

    if (built.quick) {
      const cmds = quickScrimCommands(built);
      const status = await getStatus().catch(() => null);
      const target = cfg.maplist[0];
      const onMap = status?.online && status.map === target;
      const setup = cmds.filter((c) => !c.startsWith('css_map'));
      if (onMap) {
        return out(`Quick scrim: ${cfg.team1.name} vs ${cfg.team2.name}`, await exec(setup), true,
          `Players join, pick sides and type .ready. Nobody is kicked.${quickScrimNote(built)}`);
      }
      // Change map first; MatchZy re-runs its autostart mode after a map change, so apply the rest afterwards.
      const first = await exec([`css_map ${target}`]);
      setTimeout(() => {
        rcon.exec(setup).then(
          () => store.audit(user, 'scrim-setup', `${cfg.team1.name} vs ${cfg.team2.name} applied after map change`),
          (e) => log.warn(`[scrim] delayed setup failed: ${e.message}`),
        );
      }, 15000);
      return out(`Quick scrim: ${cfg.team1.name} vs ${cfg.team2.name}`, first, true,
        `Changing map to ${target}; team names and settings are applied ~15 s later. Players pick sides and type .ready.${quickScrimNote(built)}`);
    }

    store.saveConfig(matchId, user.sid, cfg);
    store.upsertSeries({ matchid: matchId, team1: cfg.team1.name, team2: cfg.team2.name, num_maps: cfg.num_maps });
    const url = `${config.internalUrl}/api/matchconfig/${matchId}.json`;
    const output = await exec([`matchzy_loadmatch_url "${url}" "X-Config-Token" "${configToken}"`]);
    const failed = /fail|already|invalid|error/i.test(output);
    return out(
      `${failed ? 'Match load may have failed' : 'Match loaded'}: ${cfg.team1.name} vs ${cfg.team2.name} (id ${matchId})`,
      output,
      !failed,
      cfg.skip_veto ? 'Players join and type .ready.' : 'Players join; the veto starts once both teams are ready.',
    );
  }

  // ---- route handlers -------------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const method = req.method;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self' https://steamcommunity.com; frame-ancestors 'none'; base-uri 'none'");

    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');

    if (p.startsWith('/static/') && (method === 'GET' || method === 'HEAD')) {
      const name = p.slice('/static/'.length);
      if (!/^[a-z0-9_-]+\.(css|js|svg)$/.test(name)) throw new HttpError(404, 'Not found');
      const file = path.join(PUBLIC_DIR, name);
      const body = await fsp.readFile(file).catch(() => null);
      if (!body) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(name)], 'Cache-Control': 'public, max-age=300', 'Content-Length': body.length });
      return res.end(method === 'HEAD' ? undefined : body);
    }

    // --- 2D demo viewer (static bundle + demo feed) ---
    if ((p === '/viewer' || p.startsWith('/viewer/')) && (method === 'GET' || method === 'HEAD')) {
      if (!viewerEnabled) throw new HttpError(404, 'The 2D viewer is not installed in this build');
      if (p === '/viewer') return redirect(res, '/viewer/', 301);
      res.setHeader('Content-Security-Policy', VIEWER_CSP);
      if (p === '/viewer/replay') {
        // Parsed replay of a demo on this server: 200 (gzip frames), 202 while it is being prepared, 422 if unreadable.
        if (!serverReplays) return json(res, 404, { error: 'Server-side replays are not available in this build' });
        const rel = demoPathFromViewerUrl(url.searchParams.get('url'), config.publicOrigin);
        const abs = rel && resolveDemoPath(config.demosDir, rel);
        if (!abs || !(await isInsideRealRoot(config.demosDir, abs))) return json(res, 404, { error: 'No such demo' });
        const job = await replays.jobFor(rel, abs, { requireStable: false });
        if (!job) return json(res, 404, { error: 'No such demo' });
        const s = await replays.status(job.key);
        if (s.state === 'ready') return sendReplay(req, res, s.file);
        if (s.state === 'failed') return json(res, 422, { error: s.error });
        if (!(await replays.jobFor(rel, abs))) {
          return json(res, 409, { error: 'This demo is still being recorded. Try again a few minutes after the match ends.' });
        }
        replays.enqueue(job, true);
        const after = await replays.status(job.key);
        return json(res, 202, {
          status: 'processing',
          message: after.position ? `Waiting for ${after.position - 1} other demo${after.position === 2 ? '' : 's'} first.` : 'Reading the demo now.',
        }, { 'Cache-Control': 'no-store' });
      }
      const file = resolveViewerFile(config.viewerDir, p);
      if (!file || !(await sendViewerFile(req, res, file))) throw new HttpError(404, 'Not found');
      return undefined;
    }

    // --- MatchZy -> web APIs (token protected) ---
    if (p === '/api/matchzy/events') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const token = req.headers['x-events-token'];
      if (!config.eventsToken || !token || !safeEqual(token, config.eventsToken)) throw new HttpError(401, 'Bad token');
      const body = await readBody(req);
      let ev;
      try { ev = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
      const result = applyEvent(store, ev);
      if (ev.event === 'map_result' || ev.event === 'going_live' || ev.event === 'series_end') statusCache.at = 0;
      if (result.needsMapName) {
        // Fill the map name from the live server (the event payload has none).
        queryInfo(config.gameHost, config.gamePort, 2000)
          .then((info) => store.upsertMap({ ...result.needsMapName, map_name: info.map }))
          .catch(() => {});
      }
      return json(res, 200, { ok: true });
    }

    let m = /^\/api\/matchconfig\/(\d{1,15})\.json$/.exec(p);
    if (m && method === 'GET') {
      const token = req.headers['x-config-token'];
      if (!token || !safeEqual(token, configToken)) throw new HttpError(401, 'Bad token');
      const row = store.getConfig(Number(m[1]));
      if (!row) throw new HttpError(404, 'No such match');
      return json(res, 200, row.config);
    }

    // --- public ---
    if (p === '/api/status' && method === 'GET') {
      const s = await getStatus();
      return json(res, 200, { ...s, connect: config.connectAddress });
    }

    m = /^\/demos\/file\/(.+)$/.exec(p);
    if (m && (method === 'GET' || method === 'HEAD')) {
      let rel;
      try { rel = decodeURIComponent(m[1]); } catch { throw new HttpError(400, 'Bad path'); }
      const abs = resolveDemoPath(config.demosDir, rel);
      if (!abs || !(await isInsideRealRoot(config.demosDir, abs))) throw new HttpError(404, 'Not found');
      return sendFile(req, res, abs);
    }

    if (p === '/demos' && method === 'GET') {
      const session = sessions.read(req);
      const rows = buildDemoRows(store, await listDemoFiles(config.demosDir));
      return page(res, {
        title: 'Demos', session, active: 'demos',
        body: `<section class="card"><div class="card-head"><h2>Demos</h2><span class="muted small">${viewerEnabled ? '<a class="btn small" href="/viewer/" title="Opens in your browser; the file is not uploaded">Watch your own demo in 2D</a> ' : ''}${rows.length} file${rows.length === 1 ? '' : 's'}</span></div>${demosTable(rows, { viewer: serverReplays })}</section>`,
      });
    }

    if (p === '/' && method === 'GET') {
      const { session, member } = await currentUser(req);
      const status = await getStatus();
      const rows = buildDemoRows(store, (await listDemoFiles(config.demosDir)).sort((x, y) => y.mtime - x.mtime).slice(0, 8));
      const connect = {
        address: config.connectAddress,
        passwordProtected: !!config.serverPassword || status.passworded,
        password: member ? config.serverPassword : '',
      };
      return page(res, {
        title: 'Server', session, active: 'home',
        body: `${statusCard(status, connect)}
<section class="card"><div class="card-head"><h2>Latest demos</h2><a href="/demos" class="small">All demos →</a></div>${demosTable(rows, { compact: true, viewer: serverReplays })}</section>`,
      });
    }

    // --- login ---
    if (p === '/login' && method === 'GET') {
      const state = sessions.loginState(res);
      const returnTo = `${config.publicUrl}${callbackPath}?state=${encodeURIComponent(state)}`;
      return redirect(res, buildAuthUrl(returnTo, config.publicOrigin), 302);
    }

    if (p === callbackPath && method === 'GET') {
      const expected = sessions.takeLoginState(req, res);
      const state = url.searchParams.get('state');
      if (!expected || !state || !safeEqual(state, expected)) {
        return page(res, { title: 'Login failed', body: messagePage('Login failed', '<p>Login session expired or invalid. <a href="/login">Try again</a>.</p>') }, 400);
      }
      try {
        const { steamId } = await verifyAssertion(url.searchParams, {
          returnTo: `${config.publicUrl}${callbackPath}`,
          fetchImpl,
          nonceSeen: (n) => store.useNonce(n),
        });
        const name = await fetchPersonaName(steamId, { apiKey: config.steamApiKey, fetchImpl });
        const s = sessions.create(res, { steamId, name });
        store.audit(s, 'login', '');
        return redirect(res, '/admin');
      } catch (e) {
        log.warn(`[auth] ${e.message}`);
        return page(res, { title: 'Login failed', body: messagePage('Login failed', `<p>${esc(e.message)}</p><p><a href="/login">Try again</a></p>`) }, 400);
      }
    }

    if (p === '/logout' && method === 'POST') {
      const s = sessions.read(req);
      const form = await readForm(req);
      if (s && (!checkOrigin(req) || !sessions.checkCsrf(s, form.csrf))) throw new HttpError(403, 'CSRF check failed');
      sessions.destroy(res);
      return redirect(res, '/');
    }

    // --- admin ---
    if (p === '/admin' && method === 'GET') {
      const { session, member, groupError } = await currentUser(req);
      if (!session) {
        return page(res, {
          title: 'Control', active: 'admin',
          body: messagePage('Server control', '<p>Sign in with Steam. Only members of the server\'s Steam group can use the controls.</p><p><a class="btn steam" href="/login">Sign in through Steam</a></p>'),
        });
      }
      if (!member) {
        return page(res, {
          title: 'Control', session, active: 'admin',
          body: messagePage('Not allowed', groupError
            ? `<p>Could not check Steam group membership right now (${esc(groupError)}). Try again in a minute.</p>`
            : '<p>Your Steam account is not a member of this server\'s Steam group. Demos and server status are still public.</p>'),
        }, 403);
      }
      const flash = flashes.get(session.n);
      flashes.delete(session.n);

      let live = {};
      let currentMap = null;
      if (!config.rconPassword) {
        live = { error: 'RCON_PASSWORD is not set' };
      } else {
        try {
          const [g5Text, statusText] = await rcon.exec(['get5_status', 'status'], { timeoutMs: 4000 });
          live = { get5: extractJson(g5Text), statusText: statusText.trim() };
        } catch (e) {
          live = { error: e.message };
        }
      }
      const st = await getStatus();
      currentMap = st.online ? st.map : null;

      let backups = null;
      if (url.searchParams.get('backups')) {
        const mid = url.searchParams.get('matchid');
        const cmd = mid && /^\d{1,15}$/.test(mid) ? `matchzy_listbackups ${mid}` : 'matchzy_listbackups';
        try {
          const raw = await rcon.one(cmd);
          backups = { items: parseBackupList(raw), raw: raw.trim() };
        } catch (e) {
          backups = { items: [], raw: `RCON error: ${e.message}` };
        }
      }

      return page(res, {
        title: 'Control', session, active: 'admin',
        body: adminPage({
          csrf: sessions.csrfToken(session), flash, live, mapPool: config.mapPool, backups,
          audit: store.recentAudit(15), currentMap,
        }),
      });
    }

    if (p === '/admin/action' && method === 'POST') {
      const { session, member } = await currentUser(req);
      if (!session) throw new HttpError(401, 'Log in first');
      if (!member) throw new HttpError(403, 'Not a member of the Steam group');
      const form = await readForm(req);
      if (!checkOrigin(req) || !sessions.checkCsrf(session, form.csrf)) throw new HttpError(403, 'CSRF check failed');
      const action = String(form.action || '');
      let flash;
      try {
        flash = await runAction(action, form, session);
      } catch (e) {
        flash = { title: `Action failed: ${action}`, ok: false, message: e.message };
      }
      const detail = action === 'say' ? sanitizeArg(form.message, 200)
        : action === 'changemap' ? (form.custom_map || form.map)
          : action === 'restore' ? form.file
            : action === 'scrim' ? `${form.team1} vs ${form.team2} (${form.format})` : '';
      store.audit(session, action, `${detail || ''}${flash.ok ? '' : ' [failed]'}`.trim());
      flashes.set(session.n, flash);
      if (flashes.size > 500) flashes.delete(flashes.keys().next().value);
      statusCache.at = 0;
      return redirect(res, '/admin');
    }

    throw new HttpError(404, 'Not found');
  }

  const handler = async function handler(req, res) {
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(e);
      if (res.headersSent) { res.destroy(); return; }
      const wantsJson = req.url.startsWith('/api/');
      if (wantsJson) json(res, status, { error: e.message });
      else {
        const body = layout({ title: `${status}`, body: messagePage(`Error ${status}`, `<p>${esc(status === 500 ? 'Internal error' : e.message)}</p>`) });
        send(res, status, body);
      }
    }
  };
  handler.replays = replays;
  return handler;
}

export { HttpError };
