// MatchZy remote-log event ingestion (Get5-compatible event payloads).
// Field names verified against MatchZy's Events.cs / MatchData.cs (see NOTES.md).

import path from 'node:path';
import { parseDemoFilename } from './demos.js';

// High-volume events: applied, but not kept in the raw event log.
const NOISY = new Set(['round_end', 'round_start', 'player_death', 'bomb_planted', 'bomb_defused', 'bomb_exploded', 'player_say', 'grenade_thrown']);

const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => (v == null ? null : String(v).slice(0, 128));

function winnerName(winner, team1, team2) {
  const t = winner?.team;
  if (t === 'team1') return team1 || 'team1';
  if (t === 'team2') return team2 || 'team2';
  return null; // tie / none / cancelled
}

/**
 * Apply one event to the store. Returns { needsMapName: {matchid, map_number} } when the
 * map name could not be determined (caller may look it up from the live server).
 */
export function applyEvent(store, ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') throw new Error('invalid event');
  const name = ev.event;
  const matchid = int(ev.matchid);
  const mapNumber = int(ev.map_number);
  const result = {};

  if (!NOISY.has(name)) store.logEvent(name, matchid, JSON.stringify(ev).slice(0, 200000));
  if (matchid == null) return result;

  const series = () => store.getSeries(matchid);
  const configMap = (n) => {
    const cfg = store.getConfig(matchid)?.config;
    if (!cfg || !Array.isArray(cfg.maplist)) return null;
    const vetoed = cfg.maplist.length > cfg.num_maps && !(cfg.skip_veto === true || cfg.skip_veto === 1);
    return vetoed ? null : cfg.maplist[n] ?? null;
  };

  switch (name) {
    case 'series_start':
      store.upsertSeries({
        matchid,
        team1: str(ev.team1?.name),
        team2: str(ev.team2?.name),
        num_maps: int(ev.num_maps),
      });
      break;

    case 'map_picked':
      if (mapNumber != null) {
        store.upsertMap({ matchid, map_number: mapNumber, map_name: str(ev.map_name), status: 'picked' });
      }
      break;

    case 'going_live': {
      if (mapNumber == null) break;
      const s = series();
      const known = store.getMap(matchid, mapNumber)?.map_name || configMap(mapNumber);
      store.upsertMap({
        matchid, map_number: mapNumber, map_name: known, team1: s?.team1, team2: s?.team2,
        team1_score: 0, team2_score: 0, status: 'live', started_at: Date.now(),
      });
      if (!known) result.needsMapName = { matchid, map_number: mapNumber };
      break;
    }

    case 'round_end':
    case 'map_result': {
      if (mapNumber == null) break;
      const t1 = ev.team1 || {};
      const t2 = ev.team2 || {};
      const done = name === 'map_result';
      const existing = store.getMap(matchid, mapNumber);
      const mapName = existing?.map_name || configMap(mapNumber);
      store.upsertMap({
        matchid,
        map_number: mapNumber,
        map_name: mapName,
        team1: str(t1.name),
        team2: str(t2.name),
        team1_score: int(t1.score),
        team2_score: int(t2.score),
        winner: done ? str(winnerName(ev.winner, t1.name, t2.name)) : null,
        status: done ? 'done' : 'live',
        started_at: Date.now(),
        ended_at: done ? Date.now() : null,
      });
      if (!existing) store.upsertSeries({ matchid, team1: str(t1.name), team2: str(t2.name) });
      if (!mapName) result.needsMapName = { matchid, map_number: mapNumber };
      break;
    }

    case 'series_end': {
      const s = series();
      store.endSeries({
        matchid,
        s1: int(ev.team1_series_score),
        s2: int(ev.team2_series_score),
        winner: str(winnerName(ev.winner, s?.team1, s?.team2)),
      });
      break;
    }

    case 'demo_upload_ended': {
      const file = ev.filename ? path.basename(String(ev.filename)) : null;
      if (file && mapNumber != null) {
        const parsed = parseDemoFilename(file);
        store.upsertMap({ matchid, map_number: mapNumber, demo_file: file, map_name: parsed?.map ?? null });
      }
      break;
    }

    default:
      break;
  }
  return result;
}

/**
 * Join demo files with stored match data. `files` from listDemoFiles().
 * Returns rows sorted newest first: { path, name, size, date, map, team1, team2, score1, score2, matchid, ... }.
 */
export function buildDemoRows(store, files) {
  const claimed = new Set();
  const byMatch = new Map();
  const mapsFor = (id) => {
    if (!byMatch.has(id)) byMatch.set(id, store.mapsForMatch(id));
    return byMatch.get(id);
  };

  const rows = files.map((f) => {
    const parsed = parseDemoFilename(f.name);
    const row = {
      path: f.path,
      name: f.name,
      size: f.size,
      date: parsed ? parsed.date : new Date(f.mtime).toISOString().slice(0, 19),
      sortKey: f.mtime,
      map: parsed?.map ?? null,
      team1: parsed?.team1 ?? null,
      team2: parsed?.team2 ?? null,
      matchid: parsed?.matchId ?? null,
      score1: null,
      score2: null,
      winner: null,
      mapNumber: null,
      series: null,
      source: parsed ? 'filename' : 'unknown',
    };
    return row;
  });

  // Pass 1: exact demo_file matches; pass 2: same match id + map name.
  const attach = (row, m) => {
    claimed.add(`${m.matchid}:${m.map_number}`);
    row.mapNumber = m.map_number;
    row.map = m.map_name || row.map;
    row.team1 = m.team1 || row.team1;
    row.team2 = m.team2 || row.team2;
    row.score1 = m.team1_score;
    row.score2 = m.team2_score;
    row.winner = m.winner;
    row.status = m.status;
    row.source = 'events';
  };
  const passes = [
    (row, m) => m.demo_file && m.demo_file === row.name,
    (row, m) => !m.demo_file && m.map_name && row.map && m.map_name.toLowerCase() === row.map.toLowerCase(),
  ];
  for (const test of passes) {
    for (const row of rows) {
      if (row.source === 'events' || row.matchid == null || row.matchid < 0) continue;
      const m = mapsFor(row.matchid).find((x) => !claimed.has(`${x.matchid}:${x.map_number}`) && test(row, x));
      if (m) attach(row, m);
    }
  }
  for (const row of rows) {
    const s = row.matchid != null && row.matchid >= 0 ? store.getSeries(row.matchid) : null;
    if (s) {
      row.series = s;
      row.team1 = row.team1 || s.team1;
      row.team2 = row.team2 || s.team2;
    }
  }
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.sortKey - a.sortKey);
  return rows;
}
