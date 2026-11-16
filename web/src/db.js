// SQLite storage (node:sqlite, built into Node 22 - no native module to compile).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS match_configs (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS series (
  matchid INTEGER PRIMARY KEY,
  team1 TEXT, team2 TEXT,
  num_maps INTEGER,
  team1_series_score INTEGER, team2_series_score INTEGER,
  winner TEXT,
  started_at INTEGER, ended_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS maps (
  matchid INTEGER NOT NULL,
  map_number INTEGER NOT NULL,
  map_name TEXT,
  team1 TEXT, team2 TEXT,
  team1_score INTEGER, team2_score INTEGER,
  winner TEXT,
  status TEXT,
  demo_file TEXT,
  started_at INTEGER, ended_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (matchid, map_number)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  event TEXT,
  matchid INTEGER,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS events_matchid ON events(matchid);
CREATE TABLE IF NOT EXISTS openid_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  steamid TEXT,
  name TEXT,
  action TEXT,
  detail TEXT
);
`;

export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'panel.sqlite');
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      insertConfig: db.prepare('INSERT INTO match_configs (id, created_at, created_by, config) VALUES (?, ?, ?, ?)'),
      getConfig: db.prepare('SELECT * FROM match_configs WHERE id = ?'),
      maxConfigId: db.prepare('SELECT MAX(id) AS m FROM match_configs'),
      upsertSeries: db.prepare(`INSERT INTO series (matchid, team1, team2, num_maps, started_at, updated_at)
        VALUES (:matchid, :team1, :team2, :num_maps, :now, :now)
        ON CONFLICT(matchid) DO UPDATE SET
          team1 = COALESCE(excluded.team1, series.team1),
          team2 = COALESCE(excluded.team2, series.team2),
          num_maps = COALESCE(excluded.num_maps, series.num_maps),
          started_at = COALESCE(series.started_at, excluded.started_at),
          updated_at = excluded.updated_at`),
      endSeries: db.prepare(`INSERT INTO series (matchid, team1_series_score, team2_series_score, winner, ended_at, updated_at)
        VALUES (:matchid, :s1, :s2, :winner, :now, :now)
        ON CONFLICT(matchid) DO UPDATE SET
          team1_series_score = excluded.team1_series_score,
          team2_series_score = excluded.team2_series_score,
          winner = excluded.winner, ended_at = excluded.ended_at, updated_at = excluded.updated_at`),
      upsertMap: db.prepare(`INSERT INTO maps (matchid, map_number, map_name, team1, team2, team1_score, team2_score, winner, status, demo_file, started_at, ended_at, updated_at)
        VALUES (:matchid, :map_number, :map_name, :team1, :team2, :team1_score, :team2_score, :winner, :status, :demo_file, :started_at, :ended_at, :now)
        ON CONFLICT(matchid, map_number) DO UPDATE SET
          map_name = COALESCE(excluded.map_name, maps.map_name),
          team1 = COALESCE(excluded.team1, maps.team1),
          team2 = COALESCE(excluded.team2, maps.team2),
          team1_score = COALESCE(excluded.team1_score, maps.team1_score),
          team2_score = COALESCE(excluded.team2_score, maps.team2_score),
          winner = COALESCE(excluded.winner, maps.winner),
          status = CASE WHEN maps.status = 'done' AND excluded.status IN ('live', 'picked') THEN maps.status ELSE COALESCE(excluded.status, maps.status) END,
          demo_file = COALESCE(excluded.demo_file, maps.demo_file),
          started_at = COALESCE(maps.started_at, excluded.started_at),
          ended_at = COALESCE(excluded.ended_at, maps.ended_at),
          updated_at = excluded.updated_at`),
      getSeries: db.prepare('SELECT * FROM series WHERE matchid = ?'),
      getMap: db.prepare('SELECT * FROM maps WHERE matchid = ? AND map_number = ?'),
      mapsForMatch: db.prepare('SELECT * FROM maps WHERE matchid = ? ORDER BY map_number'),
      allMaps: db.prepare('SELECT m.*, s.team1 AS s_team1, s.team2 AS s_team2, s.num_maps FROM maps m LEFT JOIN series s ON s.matchid = m.matchid ORDER BY COALESCE(m.started_at, m.updated_at) DESC'),
      recentSeries: db.prepare('SELECT * FROM series ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?'),
      insertEvent: db.prepare('INSERT INTO events (received_at, event, matchid, payload) VALUES (?, ?, ?, ?)'),
      pruneEvents: db.prepare('DELETE FROM events WHERE received_at < ?'),
      nonceSeen: db.prepare('SELECT 1 FROM openid_nonces WHERE nonce = ?'),
      nonceAdd: db.prepare('INSERT OR IGNORE INTO openid_nonces (nonce, seen_at) VALUES (?, ?)'),
      noncePrune: db.prepare('DELETE FROM openid_nonces WHERE seen_at < ?'),
      audit: db.prepare('INSERT INTO audit (at, steamid, name, action, detail) VALUES (?, ?, ?, ?, ?)'),
      recentAudit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
    };
  }

  /** Match ids are seconds since epoch (unique, and far above MatchZy's own auto-increment ids). */
  newMatchId() {
    const max = Number(this.q.maxConfigId.get().m || 0);
    return Math.max(Math.floor(Date.now() / 1000), max + 1);
  }

  saveConfig(id, createdBy, config) {
    this.q.insertConfig.run(id, Date.now(), createdBy, JSON.stringify(config));
  }

  getConfig(id) {
    const row = this.q.getConfig.get(id);
    return row ? { ...row, config: JSON.parse(row.config) } : null;
  }

  upsertSeries({ matchid, team1 = null, team2 = null, num_maps = null }) {
    this.q.upsertSeries.run({ matchid, team1, team2, num_maps, now: Date.now() });
  }

  endSeries({ matchid, s1, s2, winner }) {
    this.q.endSeries.run({ matchid, s1, s2, winner, now: Date.now() });
  }

  upsertMap(m) {
    this.q.upsertMap.run({
      matchid: m.matchid,
      map_number: m.map_number,
      map_name: m.map_name ?? null,
      team1: m.team1 ?? null,
      team2: m.team2 ?? null,
      team1_score: m.team1_score ?? null,
      team2_score: m.team2_score ?? null,
      winner: m.winner ?? null,
      status: m.status ?? null,
      demo_file: m.demo_file ?? null,
      started_at: m.started_at ?? null,
      ended_at: m.ended_at ?? null,
      now: Date.now(),
    });
  }

  getSeries(id) { return this.q.getSeries.get(id) || null; }
  getMap(id, n) { return this.q.getMap.get(id, n) || null; }
  mapsForMatch(id) { return this.q.mapsForMatch.all(id); }
  allMaps() { return this.q.allMaps.all(); }
  recentSeries(limit = 20) { return this.q.recentSeries.all(limit); }

  logEvent(event, matchid, payload) {
    this.q.insertEvent.run(Date.now(), event, matchid ?? null, payload);
  }

  pruneEvents(olderThanMs) { this.q.pruneEvents.run(Date.now() - olderThanMs); }

  /** Returns true if already seen; records it otherwise. */
  useNonce(nonce) {
    this.q.noncePrune.run(Date.now() - 24 * 3600 * 1000);
    if (this.q.nonceSeen.get(nonce)) return true;
    this.q.nonceAdd.run(nonce, Date.now());
    return false;
  }

  audit(user, action, detail) {
    this.q.audit.run(Date.now(), user?.sid ?? null, user?.name ?? null, action, detail ? String(detail).slice(0, 2000) : null);
  }

  recentAudit(limit = 20) { return this.q.recentAudit.all(limit); }
}
