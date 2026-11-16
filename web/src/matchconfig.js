// Build MatchZy match configuration JSON (Get5-style schema, see NOTES.md).

const STEAM64_BASE = 76561197960265728n;
const MAP_RE = /^(?:[a-z]{2,3}_[a-z0-9_]{1,40}|\d{6,12})$/;

/** Convert a SteamID in any common form (64-bit, STEAM_X:Y:Z, [U:1:N], profile URL) to SteamID64. */
export function toSteamId64(input) {
  const s = String(input || '').trim();
  let m;
  if ((m = /^(7656119\d{10})$/.exec(s))) return m[1];
  if ((m = /steamcommunity\.com\/profiles\/(7656119\d{10})/.exec(s))) return m[1];
  if ((m = /^STEAM_[0-5]:([01]):(\d{1,10})$/i.exec(s))) {
    return (STEAM64_BASE + BigInt(m[2]) * 2n + BigInt(m[1])).toString();
  }
  if ((m = /^\[?U:1:(\d{1,10})\]?$/i.exec(s))) return (STEAM64_BASE + BigInt(m[1])).toString();
  return null;
}

/**
 * Parse a roster textarea: one player per line, "<steamid> [optional name]",
 * or several ids separated by commas/spaces. Returns { players: {id: name}, errors: [] }.
 */
export function parseRoster(text) {
  const players = {};
  const errors = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/[\s,;]+/).filter(Boolean);
    const ids = tokens.map(toSteamId64);
    if (ids.every(Boolean)) {
      ids.forEach((id) => { players[id] = players[id] || ''; });
      continue;
    }
    const id = ids[0];
    if (!id) {
      errors.push(`Not a SteamID: "${tokens[0].slice(0, 60)}"`);
      continue;
    }
    const name = line.slice(line.indexOf(tokens[0]) + tokens[0].length).trim()
      .replace(/[\u0000-\u001f"\\;]/g, '').slice(0, 32);
    players[id] = name;
  }
  return { players, errors };
}

export function cleanTeamName(s) {
  // "//" starts a comment in the CS2 console tokenizer; quotes/semicolons would break out of the command.
  return String(s || '').replace(/[\u0000-\u001f"';\\{}]/g, '').replace(/\/{2,}/g, '/').trim().slice(0, 32);
}

export function isValidMapName(m) {
  return typeof m === 'string' && MAP_RE.test(m);
}

const truthy = (v) => v === true || v === 'on' || v === '1' || v === 'true' || v === 'yes';

/**
 * Validate form input and produce { config, quick, errors }.
 * input: { team1, team2, team1_players, team2_players, team1_coaches, team2_coaches,
 *          format: 'map'|'bo1'|'bo3', map, players_per_team, min_players_to_ready,
 *          playout, coaches, knife, veto_first }
 */
export function buildMatchConfig(input, { matchId, mapPool }) {
  const errors = [];
  const team1Name = cleanTeamName(input.team1) || 'Team 1';
  const team2Name = cleanTeamName(input.team2) || 'Team 2';
  if (team1Name.toLowerCase() === team2Name.toLowerCase()) errors.push('Team names must differ.');

  const format = ['map', 'bo1', 'bo3'].includes(input.format) ? input.format : 'map';
  const ppt = Math.min(5, Math.max(1, Number.parseInt(input.players_per_team, 10) || 5));
  const minReady = Math.min(ppt, Math.max(1, Number.parseInt(input.min_players_to_ready, 10) || ppt));
  const playout = input.playout === undefined ? true : truthy(input.playout);
  const coachesAllowed = input.coaches === undefined ? true : truthy(input.coaches);
  const knife = input.knife === undefined ? true : truthy(input.knife);

  const r1 = parseRoster(input.team1_players);
  const r2 = parseRoster(input.team2_players);
  const c1 = coachesAllowed ? parseRoster(input.team1_coaches) : { players: {}, errors: [] };
  const c2 = coachesAllowed ? parseRoster(input.team2_coaches) : { players: {}, errors: [] };
  errors.push(...r1.errors.map((e) => `${team1Name}: ${e}`), ...r2.errors.map((e) => `${team2Name}: ${e}`));
  errors.push(...c1.errors.map((e) => `${team1Name} coach: ${e}`), ...c2.errors.map((e) => `${team2Name} coach: ${e}`));

  // Coaches are listed as team players (MatchZy has no coach key); they type .coach <side> in game.
  const team1Players = { ...r1.players, ...c1.players };
  const team2Players = { ...r2.players, ...c2.players };
  const n1 = Object.keys(team1Players).length;
  const n2 = Object.keys(team2Players).length;
  for (const id of Object.keys(team1Players)) {
    if (id in team2Players) errors.push(`SteamID ${id} is on both teams.`);
  }
  // A loaded MatchZy match kicks everyone who is not on a roster, so rosters are all-or-nothing.
  const quick = n1 === 0 && n2 === 0;
  if (!quick && (n1 === 0 || n2 === 0)) {
    errors.push('Give SteamIDs for both teams, or for neither (quick scrim without player lock).');
  }
  if (quick && format !== 'map') {
    errors.push('Map veto (Bo1/Bo3) needs a match config, which needs SteamIDs for both teams. Pick a single map, or add rosters.');
  }

  let maplist;
  let numMaps;
  let skipVeto;
  if (format === 'map') {
    const map = String(input.map || '').trim().toLowerCase();
    if (!isValidMapName(map)) errors.push('Pick a valid map.');
    maplist = [map];
    numMaps = 1;
    skipVeto = true;
  } else {
    maplist = mapPool.filter(isValidMapName);
    numMaps = format === 'bo3' ? 3 : 1;
    skipVeto = false;
    if (maplist.length < numMaps + 1) errors.push('Map pool too small for a veto.');
  }

  const vetoFirst = ['team1', 'team2', 'random'].includes(input.veto_first) ? input.veto_first : 'random';

  const config = {
    matchid: matchId,
    team1: { name: team1Name, players: team1Players },
    team2: { name: team2Name, players: team2Players },
    num_maps: numMaps,
    maplist,
    skip_veto: skipVeto,
    veto_first: vetoFirst,
    side_type: knife ? 'standard' : 'never_knife',
    clinch_series: true,
    players_per_team: ppt,
    min_players_to_ready: minReady,
    spectators: { players: {} },
    cvars: {
      // MatchZy's own playout switch also forces mp_overtime_enable 0, so it stays off. The server's
      // live_override.cfg already plays out all rounds (mp_match_can_clinch 0, overtime on); match cvars are
      // executed after MatchZy's playout handling, so "play out OFF" is done with mp_match_can_clinch 1.
      matchzy_playout_enabled_default: 'false',
      matchzy_knife_enabled_default: knife ? 'true' : 'false',
    },
  };
  if (!playout) config.cvars.mp_match_can_clinch = '1';
  if (format === 'map') config.map_sides = [knife ? 'knife' : 'team1_ct'];

  return {
    config,
    quick,
    format,
    playout,
    knife,
    errors,
  };
}

/** RCON commands for a "quick scrim" (no match config, nobody kicked). */
export function quickScrimCommands({ config, playout, knife }) {
  const map = config.maplist[0];
  // Without a match config, MatchZy re-applies live_override.cfg's mp_match_can_clinch when the match goes
  // live, so the server default (play out all rounds + overtime) always applies here; see quickScrimNote().
  void playout;
  return [
    'css_exitprac',
    `css_readyrequired ${config.min_players_to_ready * 2}`, // server-wide total, both teams
    'matchzy_playout_enabled_default false',
    `matchzy_knife_enabled_default ${knife ? 'true' : 'false'}`,
    `css_team1 ${config.team1.name}`,
    `css_team2 ${config.team2.name}`,
    `css_map ${map}`,
  ];
}

export function quickScrimNote({ playout }) {
  return playout ? '' : ' Note: "play out all rounds" cannot be turned off without a match config (add SteamIDs); the server default (play out + overtime) applies.';
}
