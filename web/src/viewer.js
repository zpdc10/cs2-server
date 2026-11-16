// 2D demo viewer: serves the pre-built static bundle of sparkoo/csgo-2d-demo-viewer (MIT) under /viewer/
// and feeds it demo files from DEMOS_DIR. The bundle is built in the Dockerfile (see viewer/ and NOTES.md).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Compressions the viewer's parser understands (it picks the decoder from the file name).
export const VIEWER_EXT_RE = /\.(dem|dem\.gz|gz|dem\.bz2|bz2)$/i;

// The viewer needs WebAssembly ('wasm-unsafe-eval'), a module worker and the inline styles PrimeReact injects.
// Everything else stays same-origin only.
export const VIEWER_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
  + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

// Client-side routes of the viewer app; they all get index.html.
const APP_ROUTES = new Set(['/viewer/', '/viewer/player']);

export function viewerAvailable(dir) {
  try {
    return !!dir && fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

/** Link that opens a demo (relative path inside DEMOS_DIR) in the viewer. */
export function viewerHref(relPath) {
  const file = `/demos/file/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  return `/viewer/player?demourl=${encodeURIComponent(file)}`;
}

/**
 * The viewer asks /viewer/download?url=<demourl>. Only our own /demos/file/... URLs are accepted
 * (relative, or absolute on PUBLIC_URL's origin), so the endpoint is not an open proxy.
 * Returns the relative demo path, or null.
 */
export function demoPathFromViewerUrl(urlParam, publicOrigin) {
  if (typeof urlParam !== 'string' || !urlParam || urlParam.length > 2048) return null;
  let u;
  try {
    u = new URL(urlParam, publicOrigin);
  } catch {
    return null;
  }
  if (u.origin !== publicOrigin || u.search || u.hash || u.username || u.password) return null;
  const m = /^\/demos\/file\/(.+)$/.exec(u.pathname);
  if (!m) return null;
  let rel;
  try {
    rel = m[1].split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  return VIEWER_EXT_RE.test(rel) ? rel : null;
}

/**
 * Resolve a /viewer/... request to a file in the bundle. Returns { abs, type, immutable } or null.
 * Only plain names are allowed (no dot segments, no hidden files).
 */
export function resolveViewerFile(dir, pathname) {
  if (APP_ROUTES.has(pathname)) return { abs: path.join(dir, 'index.html'), type: TYPES['.html'], immutable: false };
  const rel = pathname.slice('/viewer/'.length);
  if (!rel || rel.length > 256 || !/^[A-Za-z0-9_\-./]+$/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((s) => !s || s.startsWith('.'))) return null;
  const type = TYPES[path.extname(rel).toLowerCase()];
  if (!type) return null;
  return {
    abs: path.join(dir, ...parts),
    type,
    // Vite puts content hashes in assets/ names; the wasm parser is rebuilt with the image.
    immutable: parts[0] === 'assets',
  };
}

export async function sendViewerFile(req, res, file) {
  let st;
  try {
    st = await fsp.stat(file.abs);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) return false;
  const etag = `"v${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': file.type,
    'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file.abs).on('error', () => res.destroy()).pipe(res);
  return true;
}
