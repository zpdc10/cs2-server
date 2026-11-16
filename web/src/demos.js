// Demo listing, file-name parsing, safe path resolution and ranged streaming.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const DEMO_EXT_RE = /\.(dem|dem\.zip|zip|dem\.bz2|bz2|dem\.gz|gz)$/i;

// Known official map names, used to split "<map>_<team1>" when the map itself contains underscores.
const KNOWN_MAPS = [
  'de_ancient', 'de_ancient_night', 'de_anubis', 'de_cache', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke',
  'de_overpass', 'de_train', 'de_vertigo', 'de_basalt', 'de_edin', 'de_palais', 'de_whistle', 'de_thera',
  'de_mills', 'de_memento', 'de_assembly', 'de_grail', 'de_jura', 'de_brewery', 'de_dogtown', 'de_golden',
  'de_rooftop', 'de_palacio', 'de_sanctum', 'de_poseidon', 'de_stronghold', 'de_shortdust', 'de_shortnuke',
  'cs_italy', 'cs_office', 'cs_agency', 'ar_baggage', 'ar_shoots', 'ar_pool_day',
].sort((a, b) => b.length - a.length);

/**
 * Parse MatchZy's default demo name "{TIME}_{MATCH_ID}_{MAP}_{TEAM1}_vs_{TEAM2}"
 * where TIME is "yyyy-MM-dd_HH-mm-ss" (server local time) and spaces in team names are "_".
 * Returns null when the name does not follow that format.
 */
export function parseDemoFilename(filename, knownMaps = KNOWN_MAPS) {
  const base = path.basename(String(filename)).replace(DEMO_EXT_RE, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(-?\d+)_(.+)$/.exec(base);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, matchId, rest] = m;
  const date = `${Y}-${Mo}-${D}T${h}:${mi}:${s}`;

  let map = null;
  let teamsPart = null;
  const lower = rest.toLowerCase();
  for (const km of knownMaps) {
    if (lower.startsWith(`${km.toLowerCase()}_`)) {
      map = rest.slice(0, km.length);
      teamsPart = rest.slice(km.length + 1);
      break;
    }
  }
  if (!map) {
    // Workshop id (digits) or "<prefix>_<name>".
    const wm = /^(\d+)_(.*)$/.exec(rest) || /^([a-z]{2,3}_[a-z0-9]+)_(.*)$/i.exec(rest);
    if (!wm) return null;
    [, map, teamsPart] = wm;
  }

  let team1 = null;
  let team2 = null;
  const vs = teamsPart.lastIndexOf('_vs_');
  if (vs !== -1) {
    team1 = teamsPart.slice(0, vs);
    team2 = teamsPart.slice(vs + 4);
  } else if (teamsPart.startsWith('vs_')) {
    team1 = '';
    team2 = teamsPart.slice(3);
  } else if (teamsPart.endsWith('_vs')) {
    team1 = teamsPart.slice(0, -3);
    team2 = '';
  }
  const clean = (t) => (t == null ? null : t.replace(/_/g, ' ').trim());
  return { date, matchId: Number(matchId), map, team1: clean(team1), team2: clean(team2) };
}

/**
 * Resolve a user-supplied relative demo path inside `root`. Returns the absolute
 * path or null if it escapes the root, is not a demo file, or contains bad chars.
 */
export function resolveDemoPath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 512) return null;
  if (/[\0\\]/.test(relative)) return null;
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) return null;
  const parts = relative.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return null;
  if (!DEMO_EXT_RE.test(relative)) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, relative);
  const rel = path.relative(rootAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/** Same check after following symlinks (call on an existing file). */
export async function isInsideRealRoot(root, abs) {
  try {
    const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(abs)]);
    const rel = path.relative(realRoot, realFile);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** List demo files (top level + one level of sub-directories). */
export async function listDemoFiles(root, maxDepth = 2) {
  const out = [];
  async function walk(dir, rel, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(abs, relPath, depth + 1);
      } else if (e.isFile() && DEMO_EXT_RE.test(e.name)) {
        try {
          const st = await fsp.stat(abs);
          out.push({ path: relPath, name: e.name, size: st.size, mtime: st.mtimeMs });
        } catch { /* vanished */ }
      }
    }
  }
  await walk(root, '', 1);
  return out;
}

/**
 * Parse a Range header for a single byte range. Returns
 *   null            -> no/ignored range (send full body)
 *   'unsatisfiable' -> 416
 *   { start, end }  -> inclusive range
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=([^,]*)$/.exec(String(header).trim());
  if (!m) return null; // multi-range or other unit: ignore (allowed by RFC 9110)
  const spec = m[1].trim();
  const r = /^(\d*)-(\d*)$/.exec(spec);
  if (!r || (r[1] === '' && r[2] === '')) return null;
  let start;
  let end;
  if (r[1] === '') {
    const suffix = Number(r[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(r[1]);
    end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
    if (r[2] !== '' && Number(r[2]) < start) return null; // invalid -> ignore
  }
  if (!Number.isSafeInteger(start) || start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream a file with Content-Length / Range / HEAD / conditional support. */
export async function sendFile(req, res, abs, { downloadName, extraHeaders } = {}) {
  let fh;
  try {
    fh = await fsp.open(abs, 'r');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const size = st.size;
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const lastModified = new Date(st.mtimeMs).toUTCString();
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDisposition(downloadName || path.basename(abs)),
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      ...(typeof extraHeaders === 'function' ? extraHeaders(st) : {}),
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    let range = parseRange(req.headers.range, size);
    const ifRange = req.headers['if-range'];
    if (range && ifRange && ifRange !== etag && ifRange !== lastModified) range = null;

    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      res.end();
      return;
    }

    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range) {
      ({ start, end } = range);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(null, { fd: fh, start, end, autoClose: false, highWaterMark: 256 * 1024 });
    await pipeline(stream, res).catch(() => { /* client aborted */ });
  } finally {
    await fh.close().catch(() => {});
  }
}
