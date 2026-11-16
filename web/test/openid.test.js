import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAssertion, buildAuthUrl, parseKeyValueForm } from '../src/openid.js';

const RETURN_TO = 'https://cs2.example.com/auth/steam/callback';
const ID = '76561198000000001';

function assertion(over = {}) {
  const nonce = `${new Date().toISOString().slice(0, 19)}Z abc123`;
  return new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${ID}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${ID}`,
    'openid.return_to': `${RETURN_TO}?state=xyz`,
    'openid.response_nonce': nonce,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2lnbmF0dXJl',
    ...over,
  });
}

function fakeFetch(answer = 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n') {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => answer };
  };
  fn.calls = calls;
  return fn;
}

test('auth URL has identifier_select and return_to', () => {
  const u = new URL(buildAuthUrl(RETURN_TO, 'https://cs2.example.com'));
  assert.equal(u.origin + u.pathname, 'https://steamcommunity.com/openid/login');
  assert.equal(u.searchParams.get('openid.mode'), 'checkid_setup');
  assert.equal(u.searchParams.get('openid.return_to'), RETURN_TO);
  assert.equal(u.searchParams.get('openid.claimed_id'), 'http://specs.openid.net/auth/2.0/identifier_select');
});

test('valid assertion is verified with check_authentication', async () => {
  const f = fakeFetch();
  const r = await verifyAssertion(assertion(), { returnTo: RETURN_TO, fetchImpl: f });
  assert.equal(r.steamId, ID);
  assert.equal(f.calls.length, 1);
  const body = new URLSearchParams(f.calls[0].opts.body);
  assert.equal(body.get('openid.mode'), 'check_authentication');
  assert.equal(body.get('openid.sig'), 'c2lnbmF0dXJl');
  assert.equal(f.calls[0].opts.method, 'POST');
});

test('Steam saying is_valid:false is rejected', async () => {
  await assert.rejects(
    verifyAssertion(assertion(), { returnTo: RETURN_TO, fetchImpl: fakeFetch('ns:http://specs.openid.net/auth/2.0\nis_valid:false\n') }),
    /rejected by Steam/,
  );
});

test('forged fields are rejected before contacting Steam', async () => {
  const cases = [
    [{ 'openid.mode': 'cancel' }, /positive assertion/],
    [{ 'openid.op_endpoint': 'https://evil.example/openid/login' }, /provider endpoint/],
    [{ 'openid.return_to': 'https://evil.example/auth/steam/callback' }, /return_to/],
    [{ 'openid.claimed_id': 'https://evil.example/openid/id/76561198000000001' }, /not a Steam ID/],
    [{ 'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002' }, /mismatch/],
    [{ 'openid.signed': 'signed,op_endpoint,identity,return_to,response_nonce,assoc_handle' }, /not signed/],
    [{ 'openid.response_nonce': '2001-01-01T00:00:00Zabc' }, /expired/],
  ];
  for (const [over, re] of cases) {
    const f = fakeFetch();
    await assert.rejects(verifyAssertion(assertion(over), { returnTo: RETURN_TO, fetchImpl: f }), re);
    assert.equal(f.calls.length, 0);
  }
});

test('replayed nonce is rejected', async () => {
  const seen = new Set();
  const nonceSeen = (n) => { if (seen.has(n)) return true; seen.add(n); return false; };
  const a = assertion();
  await verifyAssertion(a, { returnTo: RETURN_TO, fetchImpl: fakeFetch(), nonceSeen });
  await assert.rejects(verifyAssertion(a, { returnTo: RETURN_TO, fetchImpl: fakeFetch(), nonceSeen }), /already used/);
});

test('HTTP error from Steam fails closed', async () => {
  const f = async () => ({ ok: false, status: 503, text: async () => '' });
  await assert.rejects(verifyAssertion(assertion(), { returnTo: RETURN_TO, fetchImpl: f }), /HTTP 503/);
});

test('key-value form parsing', () => {
  assert.deepEqual(parseKeyValueForm('ns:http://x\nis_valid:true\n'), { ns: 'http://x', is_valid: 'true' });
});
