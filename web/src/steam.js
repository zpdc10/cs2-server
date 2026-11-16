// Steam group membership (public members XML) and profile names.

const MAX_PAGES = 50;

export function parseMembersPage(xml) {
  const ids = [];
  const membersBlock = /<members>([\s\S]*?)<\/members>/i.exec(xml);
  const scope = membersBlock ? membersBlock[1] : '';
  for (const m of scope.matchAll(/<steamID64>\s*(\d{17})\s*<\/steamID64>/g)) ids.push(m[1]);
  const totalPages = Number(/<totalPages>\s*(\d+)\s*<\/totalPages>/i.exec(xml)?.[1] || 1);
  const currentPage = Number(/<currentPage>\s*(\d+)\s*<\/currentPage>/i.exec(xml)?.[1] || 1);
  const hasNext = /<nextPageLink>/i.test(xml);
  if (!/<memberList>/i.test(xml)) throw new Error('Steam group XML: unexpected response (private group or bad id?)');
  return { ids, totalPages, currentPage, hasNext };
}

export class SteamGroup {
  constructor({ groupId, cacheSec = 300, fetchImpl = fetch, log = console }) {
    this.groupId = groupId;
    this.cacheMs = cacheSec * 1000;
    this.fetch = fetchImpl;
    this.log = log;
    this.members = null;
    this.fetchedAt = 0;
    this.inflight = null;
  }

  async fetchAll() {
    const ids = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://steamcommunity.com/gid/${encodeURIComponent(this.groupId)}/memberslistxml/?xml=1&p=${page}`;
      const res = await this.fetch(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'text/xml' } });
      if (!res.ok) throw new Error(`Steam group XML HTTP ${res.status}`);
      const parsed = parseMembersPage(await res.text());
      parsed.ids.forEach((id) => ids.add(id));
      if (page >= parsed.totalPages && !parsed.hasNext) break;
      if (!parsed.ids.length) break;
    }
    return ids;
  }

  async getMembers() {
    if (!this.groupId) return new Set();
    const fresh = this.members && Date.now() - this.fetchedAt < this.cacheMs;
    if (fresh) return this.members;
    if (!this.inflight) {
      this.inflight = this.fetchAll()
        .then((ids) => {
          this.members = ids;
          this.fetchedAt = Date.now();
          return ids;
        })
        .catch((e) => {
          this.log.warn(`[steam] group fetch failed: ${e.message}`);
          if (this.members) return this.members; // serve stale on error
          throw e;
        })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  async isMember(steamId) {
    const members = await this.getMembers();
    return members.has(String(steamId));
  }
}

/** Best effort display name: Web API if a key is set, otherwise the public profile XML. */
export async function fetchPersonaName(steamId, { apiKey, fetchImpl = fetch } = {}) {
  try {
    if (apiKey) {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const j = await res.json();
        const name = j?.response?.players?.[0]?.personaname;
        if (name) return String(name).slice(0, 64);
      }
    }
    const res = await fetchImpl(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const xml = await res.text();
      const m = /<steamID>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/steamID>/.exec(xml);
      if (m && m[1].trim()) return m[1].trim().slice(0, 64);
    }
  } catch {
    // ignore
  }
  return steamId;
}
