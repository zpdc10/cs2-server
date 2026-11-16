# Shared contract between components (internal build notes)

Repo layout (each owner writes ONLY in their own dirs):
- `server/`            -> game server owner: Dockerfile/entry scripts, cfg files, MatchZy config, plugin install scripts
- `docker-compose.yml`, `.env.example`, `unraid/` -> game server owner
- `plugins/SteamGroupAdmins/` -> plugin owner (CounterStrikeSharp C# plugin)
- `web/`               -> web owner (Dockerfile + app)
- `README.md`          -> integrator (main session) writes at the end; owners put notes in `<their dir>/NOTES.md`

Services in docker-compose (names are fixed):
- `cs2`  : game server, network ports UDP+TCP 27015 (game + RCON). Container hostname `cs2`.
- `web`  : panel, built from `./web`, listens on 8080 inside, published as `${WEB_PORT:-8080}`.

Environment variables (.env, never committed; `.env.example` lists them):
- `SRCDS_TOKEN`      Steam Game Server Login Token (GSLT)
- `RCON_PASSWORD`    RCON password, used by web -> cs2:27015
- `SERVER_PASSWORD`  optional join password
- `STEAM_GROUP_ID`   64-bit Steam group ID (e.g. 103582791...), used by plugin AND web
- `STEAM_API_KEY`    optional; web may use it for player names/avatars
- `PUBLIC_URL`       e.g. http://my.ip:8080 (used for Steam OpenID return URL)
- `SESSION_SECRET`   web session cookie secret
- `APPDATA`          host path base, default /mnt/user/appdata/cs2
- `WEB_PORT`         default 8080
- `MATCHZY_EVENTS_TOKEN` shared secret: MatchZy remote log header value, checked by web

Shared data:
- Demos: MatchZy writes demos to `<csgo dir>/MatchZy_demos/` (set `matchzy_demo_path "MatchZy_demos/"`).
  Host path `${APPDATA}/demos` is mounted there in `cs2`, and mounted read-only at `/data/demos` in `web`.
- Web's own data (sqlite etc.): `${APPDATA}/web` -> `/data/web` in `web`.
- MatchZy events: game server config sets `matchzy_remote_log_url "http://web:8080/api/matchzy/events"`,
  `matchzy_remote_log_header_key "X-Events-Token"`, `matchzy_remote_log_header_value` = MATCHZY_EVENTS_TOKEN.
  Web stores match/map results (team names, scores, map, matchid) and links them to demo files.
- Match configs: web generates MatchZy match JSON, serves it at `http://web:8080/api/matchconfig/<id>.json`,
  and loads it over RCON with `matchzy_loadmatch_url "http://web:8080/api/matchconfig/<id>.json"`.

Admin model:
- Steam group members = admins. Plugin grants CounterStrikeSharp flags `@css/root` (covers MatchZy admin
  commands, which check `@css/config`/generic admin) at player connect / periodically, from the group's
  public XML: https://steamcommunity.com/gid/<STEAM_GROUP_ID>/memberslistxml/?xml=1 (paged, cached).
- Web login = Steam OpenID; allowed for control actions only if member of the same group.
- Demo list + downloads are PUBLIC (no login) so outside scrim teams can grab them. Controls require login.

Secrets: repo is PUBLIC. Never commit real tokens/passwords.

Hosting decisions (from owner):
- Web is exposed via a Cloudflare Tunnel at https://cs2.zandank.com (PUBLIC_URL default in .env.example).
  Web must work behind that reverse proxy (trust X-Forwarded-* headers, secure cookies when PUBLIC_URL is https).
  The web port does not need to be port-forwarded; only game UDP/TCP 27015 does.
- Demos are public (confirmed).
- Cloudflare Tunnel runs as a `cloudflared` service in docker-compose (image cloudflare/cloudflared, pinned tag,
  `command: tunnel --no-autoupdate run`, env `TUNNEL_TOKEN` from .env). The tunnel's public hostname
  cs2.zandank.com points to `http://web:8080`. TUNNEL_TOKEN is a secret: .env only, never committed.
