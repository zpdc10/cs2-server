// Server-rendered HTML (no client framework, no external assets).

import { VIEWER_EXT_RE, viewerHref } from './viewer.js';

export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function prettyMap(m) {
  if (!m) return '?';
  const s = String(m).replace(/^(de|cs|ar|wm)_/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function demoHref(relPath) {
  return `/demos/file/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

export function layout({ title, user, active = '', body, csrf }) {
  const nav = [
    ['/', 'Server', 'home'],
    ['/demos', 'Demos', 'demos'],
    ['/admin', 'Control', 'admin'],
  ].map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`).join('');
  const userBox = user
    ? `<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><span class="who" title="${esc(user.name || user.sid)}">${esc(user.name || user.sid)}</span><button class="link" type="submit">Log out</button></form>`
    : '<a class="btn small steam" href="/login">Sign in through Steam</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · CS2 Server</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<script src="/static/app.js" defer></script>
</head>
<body>
<header class="top">
  <div class="wrap row">
    <a class="brand" href="/"><span class="logo">CS2</span> Practice &amp; Scrims</a>
    <nav>${nav}</nav>
    <div class="user">${userBox}</div>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="wrap muted small">Self-hosted CS2 · MatchZy</footer>
</body>
</html>`;
}

export function statusCard(status, connect) {
  const online = status && status.online;
  const map = online ? prettyMap(status.map) : '—';
  return `<section class="card status" id="status" data-refresh="/api/status">
  <div class="status-head">
    <span class="dot ${online ? 'on' : 'off'}" data-k="dot"></span>
    <h2 data-k="name">${esc(online ? status.name : 'Server offline')}</h2>
  </div>
  <div class="stats">
    <div><span class="label">Map</span><span class="value" data-k="map">${esc(map)}</span></div>
    <div><span class="label">Players</span><span class="value" data-k="players">${online ? `${status.players}/${status.maxPlayers}` : '—'}</span></div>
    <div><span class="label">Mode</span><span class="value" data-k="mode">${esc(status?.mode || '—')}</span></div>
  </div>
  <div class="connect">
    <a class="btn primary block-sm" href="steam://connect/${esc(connect.address)}${connect.password ? `/${esc(connect.password)}` : ''}">Connect</a>
    <code class="copy" title="Click to copy">connect ${esc(connect.address)}${connect.password ? `; password ${esc(connect.password)}` : ''}</code>
    ${connect.passwordProtected && !connect.password ? '<span class="muted small">Password protected: ask an admin.</span>' : ''}
  </div>
</section>`;
}

export function scoreText(a, b) {
  if (a == null || b == null) return '—';
  return `${a} : ${b}`;
}

export function resultClass(a, b) {
  if (a == null || b == null || a === b) return '';
  return a > b ? 'win1' : 'win2';
}

export function demosTable(rows, { compact = false, viewer = false } = {}) {
  if (!rows.length) return '<p class="muted">No demos yet. Demos are recorded automatically when a match goes live.</p>';
  const trs = rows.map((r) => `<tr>
    <td class="nowrap date">${esc((r.date || '').replace('T', ' ').slice(0, 16))}</td>
    <td class="map">${esc(prettyMap(r.map))}</td>
    <td class="teams"><span class="${resultClass(r.score1, r.score2) === 'win1' ? 'w' : ''}">${esc(r.team1 || '?')}</span> <span class="muted">vs</span> <span class="${resultClass(r.score1, r.score2) === 'win2' ? 'w' : ''}">${esc(r.team2 || '?')}</span></td>
    <td class="score nowrap">${esc(scoreText(r.score1, r.score2))}${r.status === 'live' ? ' <span class="tag live">live</span>' : ''}</td>
    ${compact ? '' : `<td class="nowrap muted size">${esc(fmtBytes(r.size))}</td>`}
    <td class="nowrap act">${viewer && r.status !== 'live' && VIEWER_EXT_RE.test(r.path) ? `<a class="btn small" href="${esc(viewerHref(r.path))}" title="Watch a 2D replay in the browser">Watch 2D</a> ` : ''}<a class="btn small" href="${esc(demoHref(r.path))}" download>Download</a></td>
  </tr>`).join('');
  return `<div class="table-wrap"><table class="demos cards">
  <thead><tr><th>Date</th><th>Map</th><th>Teams</th><th>Score</th>${compact ? '' : '<th>Size</th>'}<th></th></tr></thead>
  <tbody>${trs}</tbody></table></div>`;
}

export function flashBox(flash) {
  if (!flash) return '';
  return `<section class="card flash ${flash.ok ? 'ok' : 'err'}">
  <strong>${esc(flash.title)}</strong>
  ${flash.message ? `<p>${esc(flash.message)}</p>` : ''}
  ${flash.output ? `<pre>${esc(flash.output)}</pre>` : ''}
</section>`;
}

function mapOptions(pool, selected) {
  return pool.map((m) => `<option value="${esc(m)}"${m === selected ? ' selected' : ''}>${esc(prettyMap(m))} (${esc(m)})</option>`).join('');
}

export function adminPage({ csrf, flash, live, mapPool, backups, audit, currentMap }) {
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const act = (action, label, cls = '', confirm = '') => `<form method="post" action="/admin/action" class="inline"${confirm ? ` data-confirm="${esc(confirm)}"` : ''}>${hidden}<input type="hidden" name="action" value="${action}"><button class="btn ${cls}" type="submit">${label}</button></form>`;

  const g5 = live?.get5;
  const liveInfo = live?.error
    ? `<p class="err-text">RCON error: ${esc(live.error)}</p>`
    : `<div class="stats">
        <div><span class="label">State</span><span class="value">${esc(g5?.gamestate || 'unknown')}${g5?.paused ? ' <span class="tag">paused</span>' : ''}</span></div>
        <div><span class="label">Match ID</span><span class="value">${esc(g5?.matchid ?? '—')}</span></div>
        <div><span class="label">Map</span><span class="value">${esc(prettyMap(currentMap))}</span></div>
        <div><span class="label">Score</span><span class="value">${g5?.team1 ? `${esc(g5.team1.name)} ${esc(g5.team1.current_map_score)} : ${esc(g5.team2.current_map_score)} ${esc(g5.team2.name)}` : '—'}</span></div>
      </div>
      ${live?.statusText ? `<details><summary>Raw <code>status</code></summary><pre>${esc(live.statusText)}</pre></details>` : ''}`;

  const backupRows = backups
    ? (backups.items.length
      ? `<div class="table-wrap"><table class="backups cards"><thead><tr><th>Match</th><th>Map #</th><th>Round</th><th>Info</th><th></th></tr></thead><tbody>${backups.items.map((b) => `<tr>
          <td data-label="Match">${esc(b.matchid)}</td><td data-label="Map #">${esc(b.mapNumber + 1)}</td><td data-label="Round">${esc(b.round)}</td><td class="muted small info">${esc(b.info)}</td>
          <td class="act"><form method="post" action="/admin/action" class="inline" data-confirm="Restore round ${esc(b.round)}? The current round state is lost.">${hidden}<input type="hidden" name="action" value="restore"><input type="hidden" name="file" value="${esc(b.file)}"><button class="btn small warn" type="submit">Restore</button></form></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<p class="muted">No backups found${backups.raw ? '' : ''}.</p>${backups.raw ? `<details><summary>Server reply</summary><pre>${esc(backups.raw)}</pre></details>` : ''}`)
    : '';

  return `${flashBox(flash)}
<section class="card">
  <div class="card-head"><h2>Live</h2><a class="btn small" href="/admin">Refresh</a></div>
  ${liveInfo}
  <div class="actions">
    ${act('pause', 'Pause')}
    ${act('unpause', 'Unpause')}
    ${act('forcestart', 'Force start', '', 'Force start the match now (skips ready-up)?')}
    ${act('endmatch', 'Cancel match', 'danger', 'Cancel the current match? No winner is recorded.')}
    ${act('endmatch_team1', 'End: team1 wins', 'danger', 'End the match with team1 as winner?')}
    ${act('endmatch_team2', 'End: team2 wins', 'danger', 'End the match with team2 as winner?')}
  </div>
</section>

<section class="card">
  <h2>Server</h2>
  <p class="muted small">Restarts the CS2 server. It checks Steam for CS2 updates and installs them before starting, so it can be offline for a few minutes. Everyone is disconnected and a running match stops.</p>
  <div class="actions">${act('restart', 'Restart server (and update CS2)', 'danger', 'Restart the CS2 server now? Everyone is disconnected and a running match stops. It checks for CS2 updates on start, which can take a few minutes.')}</div>
</section>

<div class="grid2">
<section class="card">
  <h2>Practice</h2>
  <p class="muted small">MatchZy practice mode: .bot, .spawn, .rethrow, .timer ... Ends nothing by itself: cancel a running match first.</p>
  <div class="actions">${act('practice', 'Switch to practice', 'primary')}${act('exitprac', 'Exit practice')}</div>
</section>

<section class="card">
  <h2>Deathmatch &amp; gun game</h2>
  <p class="muted small">Deathmatch: respawns, random spawns, buy anywhere with $16000 every life. Gun game: every kill gives the next gun, a knife kill on the last (knife) level wins, getting knifed costs a level. Admins can also type .dm, .dm team or .gg. Leave with practice or exit to match mode. Does not interrupt a running match.</p>
  <div class="actions">${act('deathmatch', 'Free for all', 'primary')}${act('deathmatch_team', 'Team deathmatch')}${act('gungame', 'Gun game')}${act('exitprac', 'Exit to match mode')}</div>
</section>

<section class="card">
  <h2>Map &amp; chat</h2>
  <form method="post" action="/admin/action" class="row-form">${hidden}<input type="hidden" name="action" value="changemap">
    <select name="map">${mapOptions(mapPool, currentMap)}</select>
    <input name="custom_map" placeholder="or map / workshop id" pattern="[a-z0-9_]{3,44}" aria-label="Custom map">
    <button class="btn" type="submit">Change map</button>
  </form>
  <form method="post" action="/admin/action" class="row-form">${hidden}<input type="hidden" name="action" value="say">
    <input name="message" maxlength="200" required placeholder="Message to all players" aria-label="Message">
    <button class="btn" type="submit">Say</button>
  </form>
</section>
</div>

<section class="card">
  <h2>Start a scrim</h2>
  <form method="post" action="/admin/action" class="scrim">${hidden}<input type="hidden" name="action" value="scrim">
    <div class="grid2">
      <fieldset><legend>Team 1</legend>
        <label>Name <input name="team1" maxlength="32" required placeholder="Team 1"></label>
        <label>Players (SteamID64 / STEAM_0 / profile URL, one per line, optional)
          <textarea name="team1_players" rows="5" placeholder="76561198000000001 Alice"></textarea></label>
        <label class="coach-field">Coaches (optional)
          <textarea name="team1_coaches" rows="2"></textarea></label>
      </fieldset>
      <fieldset><legend>Team 2</legend>
        <label>Name <input name="team2" maxlength="32" required placeholder="Team 2"></label>
        <label>Players (optional)
          <textarea name="team2_players" rows="5"></textarea></label>
        <label class="coach-field">Coaches (optional)
          <textarea name="team2_coaches" rows="2"></textarea></label>
      </fieldset>
    </div>
    <div class="grid3">
      <label>Format
        <select name="format" id="format">
          <option value="map">Single map</option>
          <option value="bo1">Bo1 with veto</option>
          <option value="bo3">Bo3 with veto/pick</option>
        </select></label>
      <label id="map-field">Map <select name="map">${mapOptions(mapPool, currentMap)}</select></label>
      <label>Veto starts <select name="veto_first"><option value="random">Random</option><option value="team1">Team 1</option><option value="team2">Team 2</option></select></label>
      <label>Players per team <input type="number" name="players_per_team" min="1" max="5" value="5"></label>
      <label>Min. ready per team <input type="number" name="min_players_to_ready" min="1" max="5" value="5"></label>
    </div>
    <div class="checks">
      <input type="hidden" name="playout" value="0"><label><input type="checkbox" name="playout" value="1" checked> Play out all rounds</label>
      <input type="hidden" name="coaches" value="0"><label><input type="checkbox" name="coaches" value="1" checked> Coaches allowed</label>
      <input type="hidden" name="knife" value="0"><label><input type="checkbox" name="knife" value="1" checked> Knife for sides</label>
    </div>
    <p class="muted small">With SteamIDs for both teams the match is locked (others are kicked, coaches type <code>.coach t</code>/<code>.coach ct</code>), and Bo1/Bo3 vetoes are available.
      Without any SteamIDs a quick scrim is set up instead (team names, map, playout; players pick sides and <code>.ready</code>).
      Map pool: ${esc(mapPool.map(prettyMap).join(', '))}.</p>
    <button class="btn primary block-sm" type="submit">Start scrim</button>
  </form>
</section>

<section class="card">
  <div class="card-head"><h2>Round backups</h2></div>
  <p class="muted small">MatchZy pauses the match after a restore: press Unpause when both teams are ready.</p>
  <form method="get" action="/admin" class="row-form">
    <input type="hidden" name="backups" value="1">
    <input name="matchid" inputmode="numeric" pattern="[0-9]*" placeholder="Match ID (empty = current)" aria-label="Match ID">
    <button class="btn" type="submit">List backups</button>
  </form>
  ${backupRows}
</section>

<section class="card">
  <h2>Recent actions</h2>
  ${audit.length ? `<ul class="audit">${audit.map((a) => `<li><span class="muted small">${esc(new Date(a.at).toISOString().replace('T', ' ').slice(0, 19))} UTC</span> <strong>${esc(a.name || a.steamid)}</strong> ${esc(a.action)} <span class="muted">${esc(a.detail || '')}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
</section>`;
}

export function messagePage(title, html) {
  return `<section class="card narrow"><h2>${esc(title)}</h2>${html}</section>`;
}
