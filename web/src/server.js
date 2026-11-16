// Entry point.
import http from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
if (config.sessionSecretIsDefault) console.warn('[web] SESSION_SECRET not set - using an insecure development secret!');
if (!config.steamGroupId && !config.adminSteamIds.size) console.warn('[web] STEAM_GROUP_ID not set - nobody can use the controls.');
if (!config.eventsToken) console.warn('[web] MATCHZY_EVENTS_TOKEN not set - MatchZy events will be rejected.');
if (!config.rconPassword) console.warn('[web] RCON_PASSWORD not set - controls will not work.');

const store = openDb(config.dataDir);
const handler = createApp({ config, store });

function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.url === '/healthz' || req.url.startsWith('/static/') || req.url.startsWith('/viewer/assets/')) return;
    const url = req.url.split('?')[0];
    console.log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${url} ${res.statusCode} ${Date.now() - started}ms`);
  });
  handler(req, res);
});
server.requestTimeout = 0; // allow long demo downloads
server.headersTimeout = 30000;
server.keepAliveTimeout = 65000;

// Keep the raw event log bounded.
setInterval(() => store.pruneEvents(180 * 24 * 3600 * 1000), 6 * 3600 * 1000).unref();

server.listen(config.port, config.host, () => {
  console.log(`[web] listening on ${config.host}:${config.port} (public ${config.publicUrl}, demos ${config.demosDir}, data ${config.dataDir})`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
