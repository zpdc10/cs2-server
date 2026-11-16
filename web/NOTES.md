# Web panel (`web` service): notes

Owner: web agent. Plain ESM JavaScript on Node 22 LTS with **no npm dependencies** in the server (only Node built-ins:
`node:http`, `node:net`, `node:dgram`, `node:crypto`, `node:sqlite`, `node:test`). The page is rendered on the server,
and one small script (`public/app.js`) adds a few extras. It loads nothing from external CDNs and has no inline scripts (strict CSP).

## Run

```sh
cd web
npm ci            # nothing to install, but keeps the lockfile honest
npm run build     # syntax-checks all files + checks node:sqlite is available (there is no compile step)
npm test          # node:test, 40 tests
PUBLIC_URL=http://localhost:8080 SESSION_SECRET=dev-secret-1234567890 DATA_DIR=./data DEMOS_DIR=./demos npm start
docker build -t cs2-web web/   # multi-stage: build stage runs build + tests, runtime runs as user `node` (uid 1000)
```

The container listens on 8080, keeps its SQLite database in `/data/web/panel.sqlite`, and reads demos from `/data/demos`
(mounted read-only). It has a `/healthz` endpoint and a Docker `HEALTHCHECK`. `${APPDATA}/web` on the host must be
writable by uid 1000.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | Public base URL. Used for the OpenID `return_to` and `realm`, and as the allowed `Origin` for POSTs. If it is `https://`, cookies are `Secure` + `__Host-` prefixed and proxy headers are trusted. |
| `SESSION_SECRET` | (required in production) | HMAC key for session cookies, CSRF tokens and the match-config token. Changing it logs everyone out. |
| `STEAM_GROUP_ID` | empty | Either the 64-bit group id (all digits, uses `https://steamcommunity.com/gid/<id>/memberslistxml/?xml=1`) or the custom URL name, e.g. `zandank` (uses `https://steamcommunity.com/groups/<name>/memberslistxml/?xml=1`). All pages are fetched (`&p=N`, up to 50 pages) and cached. |
| `STEAM_GROUP_CACHE_SECONDS` | `300` | Membership cache. If Steam fails, the old list is kept. |
| `ADMIN_STEAM_IDS` | empty | Optional extra SteamID64s (comma separated) allowed to use the controls even if the group XML is down. |
| `STEAM_API_KEY` | empty | Optional. Used only to look up the display name at login. Without it, the public profile XML is used. |
| `RCON_HOST` / `RCON_PORT` / `RCON_PASSWORD` | `cs2` / `27015` / empty | Source RCON target. |
| `GAME_HOST` / `GAME_PORT` | `RCON_HOST` / `27015` | Target of the A2S_INFO UDP query (public status). |
| `CONNECT_ADDRESS` | `<PUBLIC_URL host>:27015` | Address in the `steam://connect/` link. **Set it.** The tunnel hostname does not carry game UDP. |
| `SERVER_PASSWORD` | empty | Join password. It is put in the connect link only for logged-in group members. |
| `MATCHZY_EVENTS_TOKEN` | empty | Value expected in the `X-Events-Token` header on `/api/matchzy/events`. If it is empty, every event is rejected. |
| `INTERNAL_URL` | `http://web:8080` | Base URL the game server uses to fetch match configs. |
| `MAP_POOL` | `de_ancient,de_anubis,de_cache,de_dust2,de_inferno,de_mirage,de_nuke` | Veto pool and map picker. Matches server/NOTES.md. |
| `DATA_DIR` / `DEMOS_DIR` | `/data/web` / `/data/demos` | |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `TRUST_PROXY` | auto (`1` if https) | Use `CF-Connecting-IP` / `X-Forwarded-For` for the client IP in the access log. |
| `SESSION_MAX_AGE_HOURS` | `168` | |

## Routes

Public (no login):

| Route | What |
|---|---|
| `GET /` | Server status from A2S_INFO (name, map, players), the mode from RCON `get5_status` (cached 10 s), the connect link, and the latest demos. Refreshes itself every 15 s. |
| `GET /api/status` | The same status as JSON. |
| `GET /demos` | Every demo in `DEMOS_DIR` (top level + one subfolder; `.dem`, `.dem.zip`, `.zip`, `.bz2`, `.gz`) with date, map, teams and final score. |
| `GET\|HEAD /demos/file/<path>` | Download. Streams the file with `Content-Length`, single `Range` → 206, 416, `If-Range`, ETag / 304, and `Content-Disposition: attachment`. Path traversal is blocked: no `..`, `.`, dot-files, backslashes, NUL bytes or absolute paths; only demo extensions; the resolved path must stay inside the root; and `realpath` blocks symlink escapes. |
| `GET /viewer/player?demourl=/demos/file/<path>` | 2D replay viewer (see below). The demos table shows a **Watch 2D** button for `.dem`, `.dem.gz`/`.gz` and `.dem.bz2`/`.bz2` files. `GET /viewer/` lets a visitor open a demo file from their own computer (it is parsed in their browser, nothing is uploaded). |
| `GET /viewer/download?url=<demourl>` | Feeds a demo to the viewer. Only our own `/demos/file/...` URLs (relative or on `PUBLIC_URL`'s origin) are accepted, so it is not an open proxy; same path checks as the download route, plus an `X-Demo-Length` header for the progress bar. |
| `GET /login` | Redirects to Steam OpenID 2.0. A random `state` goes in a cookie and in `return_to`, which blocks login CSRF. |
| `GET /auth/steam/callback` | Checks `state`, then verifies the assertion (see below) and sets the session cookie. |
| `POST /logout` | Needs CSRF. |
| `GET /healthz` | `ok` |

Group members only (session + membership checked on every request, so the membership cache applies; POSTs also need a CSRF token **and** an `Origin`/`Referer` equal to `PUBLIC_URL`):

| Route | What |
|---|---|
| `GET /admin` | Live state (`get5_status` + raw `status`), controls, round backups (`?backups=1&matchid=`), and an audit log. |
| `POST /admin/action` | `action=` one of the actions below. The result shows as a one-time message after a 303 redirect. |

Game server → web:

| Route | What |
|---|---|
| `POST /api/matchzy/events` | MatchZy remote log. `X-Events-Token` must equal `MATCHZY_EVENTS_TOKEN` (timing-safe compare); body limit 1 MB. |
| `GET /api/matchconfig/<id>.json` | Generated match JSON. Needs the header `X-Config-Token: <HMAC(SESSION_SECRET)>`, which the panel passes in `matchzy_loadmatch_url`. This route is also reachable through the tunnel, so it is not open. |

## Admin actions → RCON commands

All of these were checked against the MatchZy 0.9.3 source (`ConsoleCommands.cs`, `BackupManagement.cs`, `MatchManagement.cs`,
`Utility.cs`) and match `server/NOTES.md`. RCON runs them as console, which MatchZy's `IsPlayerAdmin` (`player == null`) always treats as admin.

| Action | Command(s) |
|---|---|
| Switch to practice | `css_prac` (MatchZy refuses this while a match is running, so cancel the match first) |
| Exit practice | `css_exitprac` |
| Pause / unpause | `css_forcepause` / `css_forceunpause` |
| Force start | `css_start` |
| Cancel match / end with winner | `css_endmatch` / `css_endmatch team1` / `css_endmatch team2` |
| Change map | `css_map <map>` (refused while a match has started). The map must match `^[a-z]{2,3}_[a-z0-9_]+$` or be a numeric workshop id. |
| Say | `css_asay <msg>` (quotes, `;`, `\`, control characters and `//` are removed or broken up) |
| List backups | `matchzy_listbackups [matchid]` → lines are parsed for `matchzy_<matchid>_<map#>_round<NN>.json` |
| Restore backup | `matchzy_loadbackup matchzy_<id>_<map>_roundNN.json` (works for any match/map, unlike `css_restore N`, which only covers the live map). MatchZy pauses after a restore, so press Unpause. |
| Start scrim (with rosters) | Saves the config, then sends `matchzy_loadmatch_url "http://web:8080/api/matchconfig/<id>.json" "X-Config-Token" "<token>"` |
| Start scrim (no rosters, "quick") | `css_map <map>`, then about 15 s later (after MatchZy's autostart runs on the new map) `css_exitprac`, `matchzy_playout_enabled_default false`, `matchzy_knife_enabled_default <bool>`, `css_team1 <name>`, `css_team2 <name>`. If the server is already on that map, these are sent right away. |

### Generated match JSON (Get5 schema as read by MatchZy `LoadMatchFromJSON` / `ValidateMatchJsonStructure`)

```json
{
  "matchid": 1794844077,                      // integer (MatchZy casts it to long); = unix seconds, so it never collides with MatchZy's own DB ids
  "team1": { "name": "Alpha", "players": { "7656119...": "" } },
  "team2": { "name": "Bravo", "players": { "7656119...": "" } },
  "num_maps": 1 | 3,
  "maplist": ["de_nuke"] | <MAP_POOL>,
  "skip_veto": true (single map) | false (Bo1/Bo3 veto),
  "veto_first": "random" | "team1" | "team2",
  "side_type": "standard" | "never_knife",
  "map_sides": ["knife"] | ["team1_ct"],         // single map only
  "clinch_series": true,
  "players_per_team": 5,
  "min_players_to_ready": 5,
  "spectators": { "players": {} },
  "cvars": { "matchzy_playout_enabled_default": "false", "matchzy_knife_enabled_default": "true", "mp_match_can_clinch": "1" /* only when play-out is OFF */ }
}
```

* **Rosters are all-or-nothing.** In a loaded match, MatchZy kicks every player who is not in a roster
  (`EventPlayerConnectFull` → `GetPlayerTeam == None`). Because of that, a match config is only used when SteamIDs are given
  for **both** teams. With no SteamIDs, the panel sets up a "quick scrim" with commands. A Bo1/Bo3 veto needs a
  match config, so it needs rosters. SteamIDs can be given as SteamID64, `STEAM_0:x:y`, `[U:1:n]` or a profile URL, one
  per line with an optional name.
* **Coaches:** MatchZy has no coach key in the config. Coaches go into the team's `players`, and in game they type `.coach t` / `.coach ct`.
  If "Coaches allowed" is unchecked, the coach fields are ignored.
* **Play out all rounds (default ON):** MatchZy's own playout switch (`matchzy_playout_enabled_default` / `.playout`) also
  forces `mp_overtime_enable 0`, so the panel leaves it off. The server's `live_override.cfg` already sets `mp_match_can_clinch 0`
  with overtime on (see server/NOTES.md). If the box is unchecked, the config adds `mp_match_can_clinch "1"`. Match cvars are
  run after MatchZy's playout handling (`Utility.cs`: `HandlePlayoutConfig(); ExecuteChangedConvars();`) and are reset at
  series end. In a quick scrim (no config), "play out OFF" can't be applied, and the panel says so.

## MatchZy events stored

Field names come from MatchZy `Events.cs` / `MatchData.cs` (Get5 format). Each event except the noisy ones
(`round_end`, `round_start`, `player_death`, bomb events) is also kept as raw JSON in `events` for 180 days.

| Event | Stored |
|---|---|
| `series_start` | `series(matchid, team1.name, team2.name, num_maps)` |
| `map_picked` | `maps(matchid, map_number, map_name)` |
| `going_live` | map row → live, score 0:0. The payload has no map name. It is taken from our config (no veto), or from a picked map, or else from a live A2S query. |
| `round_end` | live score (`team1.score`, `team2.score`) |
| `map_result` | final score, team names, winner (`winner.team` = `team1`/`team2`), status `done` |
| `series_end` | series score + winner |
| `demo_upload_ended` | `maps.demo_file` (MatchZy 0.9.3 defines this event but never sends it; handled in case it does later) |

**Linking demos to results:** the demo name `{TIME}_{MATCH_ID}_{MAP}_{TEAM1}_vs_{TEAM2}.dem` (TIME = `yyyy-MM-dd_HH-mm-ss`,
server local time, spaces in team names → `_`) is parsed for the match id and map. The demo is linked to the stored map row
with the same match id and map name. If there is no row, date/map/teams come from the file name and no score is shown. Map names with
underscores (`de_ancient_night`) are handled with a list of known maps; workshop ids are numeric.

## Steam login

`openid.js` checks: `mode=id_res`, OpenID 2.0 `ns`, `op_endpoint == https://steamcommunity.com/openid/login`,
`return_to` origin+path equal to ours, `claimed_id == identity` and matching `https://steamcommunity.com/openid/id/7656119\d{10}`,
the required fields present in `openid.signed`, a nonce no older than 5 minutes and not used before (stored in SQLite).
Then it POSTs `check_authentication` to Steam and requires `is_valid:true`. Steam's signature is never trusted on our own.
Sessions are an HMAC-signed cookie (`__Host-cs2panel`, HttpOnly, SameSite=Lax, Secure on https) holding steamid, name,
expiry and a per-login nonce. The CSRF token is `HMAC(secret, steamid:nonce)`.

## 2D replay viewer

The viewer is [sparkoo/csgo-2d-demo-viewer](https://github.com/sparkoo/csgo-2d-demo-viewer) (MIT), the code behind 2d.sparko.cz.
Its parser is Go ([demoinfocs-golang](https://github.com/markus-wa/demoinfocs-golang), MIT) compiled to WebAssembly, so the
demo is downloaded once and parsed **in the visitor's browser**; the server only streams the file. The player is Preact.

How it gets into the image (`Dockerfile`, stages `viewer-src` and `viewer`):

1. Clone upstream at the pinned commit `VIEWER_REF`, bump its demo parser to `DEMOINFOCS_VERSION` (default `v6.0.0-rc.2`:
   upstream's rc.1 fails on current CS2 demos with `ErrDecodeFailed ... insufficient buffer`), make `wasm.go` post
   `parse-error:<reason>` to the page when parsing fails, and build it with `GOOS=js GOARCH=wasm`, plus Go's `wasm_exec.js`.
2. `npm ci --ignore-scripts` in upstream `web/`, add `@fontsource/material-icons`, run `viewer/patch.mjs`, then
   `vite build --base /viewer/` with `VITE_DOWNLOAD_SERVER_URL=/viewer` (the player then asks `/viewer/download?url=`).
3. Copy `dist/` (with `wasm/` and upstream's `LICENSE.txt`) to `/app/viewer-dist`. `VIEWER_DIR` overrides the path. If
   `index.html` is missing there, the viewer routes return 404 and the Watch 2D buttons are hidden.

`viewer/patch.mjs` moves the app's routes under `/viewer/`, replaces the upstream home page (Faceit/extension links, hosted
match list) with `viewer/UploadPage.jsx` (the upload box, a note that the file stays in the browser, and a link back to
/demos; the Demos page links to it as "Watch your own demo in 2D"), shows parse errors instead of an endless
"Loading match...", and removes the two third-party stylesheets (Google Fonts icons, w3schools W3.CSS)
in favour of the self-hosted icon font and `viewer/compat.css` (stand-ins for the few W3.CSS classes the player uses). Each
replacement must match exactly once, so if upstream changes, the image build fails instead of shipping a broken viewer.

The viewer pages get their own CSP: same-origin only, plus `'wasm-unsafe-eval'` (WebAssembly) and `style-src 'unsafe-inline'`
(PrimeReact injects styles). No third-party requests are made (checked in a browser).

To update: set `VIEWER_REF` to a newer upstream commit, rebuild the image, and open a demo with Watch 2D.
Tested 2026-11-16 at `df5a8be` + demoinfocs rc.2 in Chromium with five CS2 demos (58-365 MB, including four real
scrim demos from the owner): each loads and plays, and opening a local file from `/viewer/` works. No console or CSP errors.

Limits: the whole demo is held in the browser's memory (fine for normal match demos; very old phones may struggle).
`.zip` demos are not supported by the viewer and only get a Download button.

## Dependencies (owner rule: OSI open source + maintained; checked 2026-11-16)

| Dependency | Version | License | Last release | Repo |
|---|---|---|---|---|
| npm packages (runtime server) | **none** | n/a | n/a | n/a |
| 2D viewer: sparkoo/csgo-2d-demo-viewer (built into the image, runs in the visitor's browser) | commit `df5a8be` (2026-10-30) | MIT | no tagged releases; commits weekly, last 2026-10-30 | https://github.com/sparkoo/csgo-2d-demo-viewer |
| 2D viewer: demoinfocs-golang (CS2 demo parser, compiled to WebAssembly) | v6.0.0-rc.2 (`DEMOINFOCS_VERSION`; upstream pins rc.1) | MIT | rc.2 in 2026-11 | https://github.com/markus-wa/demoinfocs-golang |
| 2D viewer: front-end packages from upstream's lockfile | preact 10.25, primereact 10.8.5, preact-iso 2.8.1, axios 1.21.0, google-protobuf 3.21.4, web-vitals 3.5.2; build only: vite 8.3.5, dotenv 16.4.5 | MIT; google-protobuf BSD-3-Clause + Apache-2.0; web-vitals Apache-2.0; dotenv BSD-2-Clause | every project released in Aug-Nov 2026 (newer majors exist; upstream pins these) | see upstream `web/package.json` |
| 2D viewer: `@fontsource/material-icons` (replaces Google Fonts CDN) | 5.3.0 | OFL-1.1 (font Apache-2.0) | 2026-07 | https://github.com/fontsource/font-files |
| Docker build image `golang:1.27-alpine` (viewer stage only) | Go 1.27 | BSD-3-Clause | official image | https://github.com/docker-library/golang |
| Node.js (runtime; `node:sqlite` bundles SQLite 3.53, public domain) | 22.23.x LTS "Jod" (tested locally with 22.23.4) | MIT | v22.23.5 on 2026-11-11 | https://github.com/nodejs/node |
| Docker base image `node:22.23-alpine3.24` (official image) | 22.23.5 / Alpine 3.24 | MIT (image build files); Alpine packages under OSI licenses | tag pushed 2026-11-12 | https://github.com/nodejs/docker-node |

Node 22 is in maintenance LTS until 2027-04-30. To move to Node 24 LTS ("Krypton", v24.22.3 released 2026-11-10), change
`ARG NODE_IMAGE` in the Dockerfile to `node:24.22-alpine3.24` (not tested here). `node:sqlite` prints an ExperimentalWarning,
which is silenced with `--disable-warning=ExperimentalWarning`.

## Assumptions / uncertain points

1. **RCON output capture:** this assumes CS2 sends console output printed during an RCON command (`Server.PrintToConsole`,
   `ReplyToCommand` from CSS plugins) back in the RCON response. server/NOTES.md lists the same open point. If replies come back
   empty, the actions still run; the backup list and live state would be empty.
2. **RCON multi-packet:** the client sends an empty `SERVERDATA_RESPONSE_VALUE` after each command and stops when the server
   mirrors it (classic Source behaviour). If CS2 does not mirror, it falls back to 400 ms of silence after data, or 2.5 s with no data.
   Commands that print nothing therefore take about 2.5 s.
3. `de_cache` as the Active Duty map name. Sources disagreed (Overpass vs Cache); followed server/NOTES.md. Override with `MAP_POOL`.
4. In a quick scrim the delayed setup (15 s after `css_map`) assumes the map loads in under about 14 s. If team names are missing, press
   "Start scrim" again once the map has loaded (it then skips the map change).
5. MatchZy refuses `matchzy_loadmatch_url` while a match is already set up. The panel shows MatchZy's reply, and the admin cancels
   the match first. Match load success is judged from the reply text (`fail|already|invalid|error`).
6. The demo date comes from the file name (server local time, `TZ` of the cs2 container); there is no timezone conversion.
7. Practice vs idle: `get5_status` has no practice state, so the public "Mode" shows "Practice" only when the panel itself
   switched to practice (in memory; lost on restart).
8. Not built with Docker here (no Docker daemon in the sandbox). `npm ci && npm run build && npm test` pass on Node 22.23.4,
   and the full admin flow was smoke-tested against a fake RCON server.
