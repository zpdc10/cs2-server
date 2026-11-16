// Central configuration, read once from the environment (see NOTES.md for the full list).

const DEFAULT_MAP_POOL = 'de_ancient,de_anubis,de_cache,de_dust2,de_inferno,de_mirage,de_nuke';

function list(value, fallback = '') {
  return String(value ?? fallback)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const publicUrl = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, '');
  let publicOrigin;
  let publicHost;
  try {
    const u = new URL(publicUrl);
    publicOrigin = u.origin;
    publicHost = u.hostname;
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${publicUrl}`);
  }
  const secure = publicUrl.startsWith('https://');

  const sessionSecret = env.SESSION_SECRET || '';
  const isProduction = env.NODE_ENV === 'production';
  if (!sessionSecret || sessionSecret.length < 16) {
    if (isProduction) {
      throw new Error('SESSION_SECRET must be set (at least 16 characters).');
    }
  }

  const gamePort = int(env.GAME_PORT, 27015);
  return {
    port: int(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    publicUrl,
    publicOrigin,
    secure,
    trustProxy: secure || env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    sessionSecret: sessionSecret || 'dev-insecure-secret-change-me',
    sessionSecretIsDefault: !sessionSecret,
    sessionMaxAgeSec: int(env.SESSION_MAX_AGE_HOURS, 24 * 7) * 3600,

    steamGroupId: (env.STEAM_GROUP_ID || '').trim(),
    steamApiKey: (env.STEAM_API_KEY || '').trim(),
    adminSteamIds: new Set(list(env.ADMIN_STEAM_IDS)),
    groupCacheSec: int(env.STEAM_GROUP_CACHE_SECONDS, 300),

    rconHost: env.RCON_HOST || 'cs2',
    rconPort: int(env.RCON_PORT, gamePort),
    rconPassword: env.RCON_PASSWORD || '',
    gameHost: env.GAME_HOST || env.RCON_HOST || 'cs2',
    gamePort,
    // Address players use to join (the web tunnel does not carry game traffic).
    connectAddress: env.CONNECT_ADDRESS || `${publicHost}:${gamePort}`,
    serverPassword: env.SERVER_PASSWORD || '',

    eventsToken: env.MATCHZY_EVENTS_TOKEN || '',
    // URL the game server uses to reach the web container (docker network).
    internalUrl: (env.INTERNAL_URL || 'http://web:8080').replace(/\/+$/, ''),

    dataDir: env.DATA_DIR || '/data/web',
    demosDir: env.DEMOS_DIR || '/data/demos',
    mapPool: list(env.MAP_POOL, DEFAULT_MAP_POOL),
  };
}
