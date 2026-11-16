// Stateless signed-cookie sessions + CSRF tokens.

import crypto from 'node:crypto';

const COOKIE = 'cs2panel';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function encodeSession(secret, payload) {
  const data = b64u(JSON.stringify(payload));
  return `${data}.${sign(secret, `session:${data}`)}`;
}

export function decodeSession(secret, value, now = Date.now()) {
  if (!value || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const data = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!safeEqual(mac, sign(secret, `session:${data}`))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) s += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  return s;
}

export class Sessions {
  constructor({ secret, secure, maxAgeSec }) {
    this.secret = secret;
    this.secure = secure;
    this.maxAgeSec = maxAgeSec;
    this.cookieName = secure ? `__Host-${COOKIE}` : COOKIE;
  }

  read(req) {
    const cookies = parseCookies(req.headers.cookie);
    return decodeSession(this.secret, cookies[this.cookieName]);
  }

  create(res, { steamId, name }) {
    const payload = {
      sid: steamId,
      name,
      exp: Math.floor(Date.now() / 1000) + this.maxAgeSec,
      n: crypto.randomBytes(9).toString('base64url'), // per-login nonce, binds CSRF token
    };
    appendHeader(res, 'Set-Cookie', serializeCookie(this.cookieName, encodeSession(this.secret, payload), {
      maxAge: this.maxAgeSec, secure: this.secure,
    }));
    return payload;
  }

  destroy(res) {
    appendHeader(res, 'Set-Cookie', serializeCookie(this.cookieName, '', { maxAge: 0, secure: this.secure }));
  }

  csrfToken(session) {
    return sign(this.secret, `csrf:${session.sid}:${session.n}`);
  }

  checkCsrf(session, token) {
    return !!session && typeof token === 'string' && safeEqual(token, this.csrfToken(session));
  }

  /** Short-lived signed state for the OpenID round trip (prevents login CSRF). */
  loginState(res) {
    const state = crypto.randomBytes(16).toString('base64url');
    appendHeader(res, 'Set-Cookie', serializeCookie(`${COOKIE}_login`, state, { maxAge: 600, secure: this.secure }));
    return state;
  }

  takeLoginState(req, res) {
    const v = parseCookies(req.headers.cookie)[`${COOKIE}_login`];
    appendHeader(res, 'Set-Cookie', serializeCookie(`${COOKIE}_login`, '', { maxAge: 0, secure: this.secure }));
    return v || null;
  }
}

export function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (!prev) res.setHeader(name, value);
  else res.setHeader(name, [].concat(prev, value));
}
