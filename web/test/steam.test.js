import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBaseUrl, parseMembersPage, SteamGroup } from '../src/steam.js';

const page = (ids, cur, total) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<memberList><groupID64>103582791429521408</groupID64><groupDetails><groupName><![CDATA[x]]></groupName></groupDetails>
<memberCount>${ids.length}</memberCount><totalPages>${total}</totalPages><currentPage>${cur}</currentPage><startingMember>0</startingMember>
${cur < total ? `<nextPageLink><![CDATA[https://steamcommunity.com/groups/zandank/memberslistxml/?xml=1&p=${cur + 1}]]></nextPageLink>` : ''}
<members>${ids.map((i) => `<steamID64>${i}</steamID64>`).join('')}</members></memberList>`;

test('group URL from numeric id or custom name', () => {
  assert.equal(groupBaseUrl('103582791429521408'), 'https://steamcommunity.com/gid/103582791429521408');
  assert.equal(groupBaseUrl('zandank'), 'https://steamcommunity.com/groups/zandank');
  assert.equal(groupBaseUrl('a/../b'), 'https://steamcommunity.com/groups/a%2F..%2Fb');
});

test('parse members page', () => {
  const p = parseMembersPage(page(['76561197960290419', '76561197960290420'], 1, 2));
  assert.deepEqual(p.ids, ['76561197960290419', '76561197960290420']);
  assert.equal(p.totalPages, 2);
  assert.equal(p.hasNext, true);
  assert.throws(() => parseMembersPage('<html>error</html>'), /unexpected response/);
});

test('paged fetch + cache', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const p = Number(new URL(url).searchParams.get('p'));
    return { ok: true, text: async () => page([`7656119796029041${p}`], p, 2) };
  };
  const g = new SteamGroup({ groupId: 'zandank', fetchImpl, log: { warn() {} } });
  assert.equal(await g.isMember('76561197960290412'), true);
  assert.equal(await g.isMember('76561197960290419'), false);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/steamcommunity\.com\/groups\/zandank\/memberslistxml\/\?xml=1&p=1$/);
});
