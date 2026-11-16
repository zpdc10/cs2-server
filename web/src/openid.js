// Steam OpenID 2.0 (https://steamcommunity.com/dev) - we verify the assertion
// ourselves with a direct check_authentication request to Steam.

export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})\/?$/;

export function buildAuthUrl(returnTo, realm) {
  const params = new URLSearchParams({
    'openid.ns': NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params}`;
}

/** Parse "key:value\n" key-value form encoding (OpenID 2.0 section 4.1.1). */
export function parseKeyValueForm(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function sameReturnTo(received, expected) {
  try {
    const a = new URL(received);
    const b = new URL(expected);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/**
 * Validate a positive assertion. Returns { steamId } or throws.
 * `query` is a URLSearchParams (or plain object) of the callback query string.
 * `fetchImpl` is injectable for tests.
 * `nonceSeen(nonce)` should return true if the nonce was already used (replay).
 */
export async function verifyAssertion(query, {
  returnTo, fetchImpl = fetch, nonceSeen = () => false, maxNonceAgeMs = 5 * 60 * 1000, now = Date.now(),
}) {
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  const get = (k) => q.get(`openid.${k}`);

  if (get('mode') !== 'id_res') throw new Error('OpenID: not a positive assertion');
  if (get('ns') !== NS) throw new Error('OpenID: bad namespace');
  if (get('op_endpoint') !== STEAM_OPENID_ENDPOINT) throw new Error('OpenID: unexpected provider endpoint');
  if (!sameReturnTo(get('return_to') || '', returnTo)) throw new Error('OpenID: return_to mismatch');

  const claimed = get('claimed_id') || '';
  const identity = get('identity') || '';
  const m = CLAIMED_ID_RE.exec(claimed);
  if (!m) throw new Error('OpenID: claimed_id is not a Steam ID');
  if (identity !== claimed) throw new Error('OpenID: identity/claimed_id mismatch');

  // The signed fields must cover what we rely on.
  const signed = (get('signed') || '').split(',');
  for (const f of ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle']) {
    if (!signed.includes(f)) throw new Error(`OpenID: field ${f} not signed`);
  }

  const nonce = get('response_nonce') || '';
  const nm = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(nonce);
  if (!nm) throw new Error('OpenID: bad nonce');
  const ts = Date.parse(nm[1]);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxNonceAgeMs) throw new Error('OpenID: nonce expired');
  if (await nonceSeen(nonce)) throw new Error('OpenID: nonce already used');

  // Direct verification with the provider.
  const body = new URLSearchParams();
  for (const [k, v] of q) {
    if (k.startsWith('openid.')) body.set(k, v);
  }
  body.set('openid.mode', 'check_authentication');
  const res = await fetchImpl(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`OpenID: check_authentication HTTP ${res.status}`);
  const kv = parseKeyValueForm(await res.text());
  if (kv.ns && kv.ns !== NS) throw new Error('OpenID: bad namespace in verification');
  if (kv.is_valid !== 'true') throw new Error('OpenID: assertion rejected by Steam');

  return { steamId: m[1] };
}
