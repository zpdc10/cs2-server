# Game server (`cs2` service) - notes

Owner: game-server agent. Covers `server/`, `docker-compose.yml`, `.env.example`, `unraid/`.
Everything here was checked against upstream sources on **2026-11-16** unless it is listed under "Unverified".

## What was chosen

| Component | Version (pinned) | Source / check |
|---|---|---|
| Base image | `joedwards32/cs2:5.0.1` (Docker Hub, pushed 2026-10-24; git tag v5.0.1) | github.com/joedwards32/CS2, read `steamrt4/Dockerfile` + `etc/entry.sh` at that tag |
| Metamod:Source | 2.0.0 build **1491** (`mmsource-2.0.0-git1491-linux.tar.gz`) | alliedmodders/metamod-source release `2.0.0.1491`; contains `addons/metamod/bin/linuxsteamrt64/metamod.2.cs2.so` |
| CounterStrikeSharp | **v1.0.380** with-runtime (`counterstrikesharp-with-runtime-linux-1.0.380.zip`, bundles .NET 10.0.3) | roflmuffin/CounterStrikeSharp release `v1.0.380` |
| MatchZy | **0.9.3** (`MatchZy-0.9.3.zip`, net10.0, built against CSS API 1.0.376, needs CSS >= v369) | shobhit-pathak/MatchZy release `0.9.3`; source read at that tag |
| SteamGroupAdmins | built from `plugins/SteamGroupAdmins` with `mcr.microsoft.com/dotnet/sdk:10.0` | multi-stage build, net10.0 / CSS API 1.0.380 |
| cloudflared | `cloudflare/cloudflared:2026.10.7` | Docker Hub tag, pushed 2026-10-30 |

SHA-256 of each release asset is pinned in `server/Dockerfile` and verified at build time.

### Dependency licenses and maintenance (owner rule: OSI open source + active; Valve/SteamCMD excepted)

Checked 2026-11-16. "Last activity" = latest commit on the default branch (shallow clone) and latest release used.
All repos received commits in the last month, so none is archived.

| Dependency | Version used | License | Last commit / release | Repo |
|---|---|---|---|---|
| CS2 image (joedwards32/cs2) | 5.0.1 | MIT | commit 2026-10-24, release v5.0.1 2026-10-24 | https://github.com/joedwards32/CS2 |
| Metamod:Source | 2.0.0 build 1491 | zlib/libpng | commit 2026-11-15, build 1491 2026-11-15 | https://github.com/alliedmodders/metamod-source |
| CounterStrikeSharp | v1.0.380 (with .NET 10.0.3 runtime, MIT) | GPL-3.0 with plugin linking exception (+ MIT parts) | commit 2026-11-12, v1.0.380 2026-11-12 | https://github.com/roflmuffin/CounterStrikeSharp |
| MatchZy | 0.9.3 (bundles CsvHelper, Dapper, MySqlConnector, Newtonsoft.Json, Microsoft.Data.Sqlite: MIT/Apache-2.0/MS-PL) | MIT | commit 2026-11-13, 0.9.3 2026-11-13 | https://github.com/shobhit-pathak/MatchZy |
| SteamGroupAdmins | this repo | this repo's license | - | `plugins/SteamGroupAdmins` |
| cloudflared | 2026.10.7 | Apache-2.0 | commit 2026-11-16, 2026.10.7 2026-10-30 | https://github.com/cloudflare/cloudflared |
| .NET SDK image (build stage only) | mcr.microsoft.com/dotnet/sdk:10.0 | MIT | dotnet-docker commit 2026-11-13 | https://github.com/dotnet/dotnet-docker |
| Debian (fetch stage only) | debian:trixie-slim (current stable; bookworm avoided as it is past regular support) | DFSG / OSI licenses | image 2026-11-05 | https://github.com/debuerreotype/docker-debian-artifacts |
| Steam Runtime 4 SDK (base of the CS2 image) | registry.gitlab.steamos.cloud/steamrt/steamrt4/sdk | Valve-provided (Debian-based; open-source packages + Valve tooling) - under the Valve/SteamCMD exception | rebuilt by Valve, used by CS2 image 5.0.1 | https://gitlab.steamos.cloud/steamrt/steamrt |
| SteamCMD + CS2 dedicated server | latest from Steam | proprietary (Valve) - accepted exception | auto-updated on start | https://developer.valvesoftware.com/wiki/SteamCMD |

The community CS2 image passes the rule (MIT, release 3 weeks ago), so it is kept rather than replaced with our own
Dockerfile. It is a thin wrapper (Dockerfile + `entry.sh`) that we have read in full; if it ever goes stale, its
logic is easy to fold into `server/`.

### How it fits together

* `server/Dockerfile` (build context = repo root):
  1. `plugin-build`: `dotnet publish plugins/SteamGroupAdmins -c Release -o /out/SteamGroupAdmins` (CSS API dll removed from output).
  2. `fetch`: downloads Metamod / CSS / MatchZy, checks sha256, unpacks to `/dist`.
  3. final: `FROM joedwards32/cs2:5.0.1`, copies `/dist` + our scripts/cfgs to `/opt/cs2-stack`, replaces `/etc/server.cfg` with `server/cfg/server.cfg` (same `{{PLACEHOLDERS}}` + a few extras). Runs as uid/gid 1000.
  `server/Dockerfile.dockerignore` keeps the context small (only `server/` and `plugins/SteamGroupAdmins/`).
* Start sequence: `entry-wrapper.sh` (validates passwords, overwrites `${STEAMAPPDIR}/pre.sh`) -> base `entry.sh` (steamcmd update, renders server.cfg) -> sources `pre.sh` -> `install-plugins.sh` -> `cs2`.
* `install-plugins.sh` is idempotent:
  * copies Metamod/CSS/MatchZy only when `/opt/cs2-stack/dist/VERSIONS` differs from `csgo/addons/.cs2-stack-versions` or a key binary is missing (old `bin/`, `api/`, `dotnet/`, `plugins/MatchZy` are removed first; `configs/` and `cfg/MatchZy` data such as saved nades are kept);
  * always re-copies SteamGroupAdmins;
  * **always checks `csgo/gameinfo.gi`** and inserts `Game csgo/addons/metamod` after the `Game_LowViolence` line if missing. Because it runs after steamcmd on every start, a CS2 update that resets gameinfo.gi is fixed by simply restarting the container. (If CS2 updates while the server runs, the server must be restarted anyway.)
  * renders `server/cfg/MatchZy/*_override.cfg` into `csgo/cfg/MatchZy/` (fills `{{MATCHZY_EVENTS_TOKEN}}`, `{{MATCHZY_REMOTE_LOG_URL}}`).
* MatchZy's stock `cfg/MatchZy/*.cfg` are overwritten by MatchZy updates; MatchZy (0.9.x) execs `<name>_override.cfg` right after each one, so all our settings live in `config_override.cfg` and `live_override.cfg`.

### Paths (inside `cs2`)

| What | Path | Host |
|---|---|---|
| Game install | `/home/steam/cs2-dedicated` | `${APPDATA}/cs2-data` (~60 GB) |
| csgo dir | `/home/steam/cs2-dedicated/game/csgo` | |
| Demos | `<csgo>/MatchZy_demos/` (`matchzy_demo_path MatchZy_demos/`) | `${APPDATA}/demos` (web: `/data/demos:ro`) |
| Round backups | `<csgo>/MatchZyDataBackup/matchzy_<matchid>_<mapnumber>_round<NN>.json` (+ Valve `.txt` backups in `<csgo>/`) | inside cs2-data |
| MatchZy DB / saved nades | `<csgo>/cfg/MatchZy/` | inside cs2-data |

Demo file names: `{TIME}_{MATCH_ID}_{MAP}_{TEAM1}_vs_{TEAM2}.dem`. Demos are written by uid 1000 with default umask (world-readable).

## MatchZy configuration (what the scrim/practice behaviour is)

* Startup mode: **match mode** (`matchzy_autostart_mode 1`: warmup + `.ready`). Admins type `.prac` for practice.
* Practice (`.prac`): MatchZy's stock `prac.cfg` (sv_cheats, infinite ammo, grenade trajectories, buy anywhere, respawn) with `.bot`, `.cbot`, `.nobots`, `.savenade`, `.loadnade`, `.throw*`, `.rethrow`, `.spawn N`, `.ctspawn`, `.tspawn`, `.showspawns`, `.noflash`, `.ff`, `.dryrun`, `.timer`, etc. Lineups saved as global (`matchzy_save_nades_as_global_enabled true`) so the team shares them.
* Scrim: knife round on (`.roundknife` toggles), winner `.stay`/`.switch`; ready-up with 10 players required (`.readyrequired N`; admins `.forceready` / `.start`).
* Coaches: players type `.coach t` / `.coach ct` (`.uncoach`). Max players 12 = 10 + 2 coaches.
* Pauses: `.tac` = tactical timeout (3 x 30 s per team, +1 per OT); `.tech` / `.pause` = technical pause, unlimited, both teams `.unpause`; admin `.fp` / `.fup`.
* **Play out all rounds with overtime**: `live_override.cfg` sets `mp_maxrounds 24`, `mp_match_can_clinch 0`, `mp_overtime_enable 1` (MR3 OT, $12,500). MatchZy's own playout switch (`matchzy_playout_enabled_default` / `.playout`, verified in source `HandlePlayoutConfig`) **also forces `mp_overtime_enable 0`**, so it is left off; with it off, MatchZy re-reads `mp_match_can_clinch` / `mp_overtime_enable` from `live_override.cfg` 1 s after going live, so our values stick. Do not toggle `.playout` unless you want no overtime. Note: with clinch off, overtime halves also play all 6 rounds.
* Round rules: 1:55 rounds (`mp_roundtime(_defuse) 1.92`), 40 s C4, 15 s freeze, 20 s buy, $800 start, $16,000 max, 15 s halftime. CS2 is sub-tick, there is no tickrate setting.
* Backups: `mp_backup_round_auto 1`; `.stop` enabled (both teams type it -> current round restored); admins `.restore <round>`; match pauses after restore.
* Demos: recorded automatically for every match that goes live (`matchzy_demo_recording_enabled true`, `tv_enable 1` from `TV_ENABLE=1`).
* Events: `matchzy_remote_log_url "http://web:8080/api/matchzy/events"`, header `X-Events-Token: ${MATCHZY_EVENTS_TOKEN}`.

### Default map pool (Active Duty since Premier Season 5, 2026-07-08: Cache in, Overpass out)

`de_ancient de_anubis de_cache de_dust2 de_inferno de_mirage de_nuke` - the web panel should use this list for
match JSON `maplist` / veto. The server starts on `mg_active` / `de_mirage` (`CS2_STARTMAP`).

## Admin flags -> MatchZy commands

MatchZy's `IsPlayerAdmin` (Utility.cs) accepts the listed flags **or `@css/root`** (always appended), and also
treats the server console / RCON (`player == null`) as admin. SteamGroupAdmins grants `@css/root` to Steam group
members, so group members can use everything below. No MatchZy `admins.json` is needed.

| Flag MatchZy checks | Chat commands |
|---|---|
| `@css/config` | `.start/.force/.forcestart`, `.endmatch/.forceend`, `.restart/.rr`, `.restore N`, `.fp/.forcepause`, `.fup/.forceunpause`, `.roundknife/.rk`, `.playout`, `.readyrequired N`, `.whitelist`, `.team1/.team2 NAME`, `.globalnades`, `.settings`, `.skipveto`, `.forceready` (needs `matchzy_allow_force_ready`) |
| `@css/map` or `@custom/prac` | `.prac/.tactics`, `.match/.exitprac`, `.dryrun`, `.sleep` (= deathmatch here), `.dm` / `.dm team` (DeathmatchMode plugin) |
| `@css/map` | `.map NAME`, `.rmap`, `.addreadytime N` |
| `@css/rcon` | `.rcon CMD` |
| `@css/chat` | `.asay MSG` |
| none (any player) | `.ready/.unready`, `.tac`, `.tech/.pause`, `.unpause`, `.stop`, `.coach t|ct`, `.uncoach`, `.stay/.switch` (knife winner), all practice helpers once in `.prac` |

## RCON commands for the web panel (`cs2:27015`, password `RCON_PASSWORD`)

All are server-console commands registered by MatchZy (checked in MatchZy 0.9.3 source). From RCON they run
as console, i.e. always admin. **Quote every argument that contains `/`, `:` or spaces** - the CS2 tokenizer
treats unquoted `//` as a comment and `:` as a separator.

### Mode switching
| Action | Command | Notes |
|---|---|---|
| Practice mode | `css_prac` | Refused if a match has started (end it first). Alias `css_tactics`. |
| Leave practice -> match mode (warmup, ready-up) | `css_match` | Alias `css_exitprac`. No-op if already in match mode or a match is running. |
| Deathmatch | `css_dm` / `css_dm team` | DeathmatchMode plugin. Uses MatchZy's sleep mode: `css_sleep` / `.sleep` now also start deathmatch (`MatchZy/sleep_override.cfg`). Leave with `css_prac` / `css_match`. `css_dm_status` prints the state. See `plugins/DeathmatchMode/README.md`. |
| Dry run (in practice only) | `css_dryrun` | |
| Change map (no match running) | `css_map de_mirage` | Also `changelevel de_mirage` (plain Valve command). `css_map mirage` adds `de_`. |

### Loading / controlling a match
| Action | Command | Notes |
|---|---|---|
| Load match JSON | `matchzy_loadmatch_url "http://web:8080/api/matchconfig/<id>.json"` | Console-only. Optional header: `matchzy_loadmatch_url "<url>" "<HeaderName>" "<value>"` (header used only when both given). Fails with "match is already setup" if one is loaded -> `css_endmatch` first. Ends practice mode automatically. |
| Load match from file | `matchzy_loadmatch <path relative to csgo/>` | Console-only. |
| Set team names (manual scrim, before start) | `css_team1 NAME`, `css_team2 NAME` | Special characters are stripped. |
| Toggle knife round | `css_roundknife` | Toggle, not set. Default on. |
| Toggle playout | `css_playout` | Toggle. **Turning it on disables overtime**; leave off (see above). |
| Required ready players | `css_readyrequired 10` | |
| Force start (skip ready-up) | `css_start` | Aliases `css_force`, `css_forcestart`. Refused in practice mode. |
| End / cancel match | `css_endmatch` | Optional `css_endmatch team1` / `css_endmatch team2` to end with a winner. Aliases `css_forceend`, `get5_endmatch`. |
| Reset match to warmup | `css_rr` | Alias `css_restart`. |

### Pausing
| Action | Command | Notes |
|---|---|---|
| Admin pause | `css_forcepause` | Aliases `css_fp`, `sm_pause`. Only after the match started; refused at halftime/post-game. Only an admin (or console) can unpause it. |
| Admin unpause | `css_forceunpause` | Aliases `css_fup`, `sm_unpause`. |
| Tactical timeout for a side | `timeout_terrorist_start` / `timeout_ct_start` | Native CS2 commands (what MatchZy's `.tac` runs). `css_tac` ignores console. |

### Backups / restore
| Action | Command | Notes |
|---|---|---|
| Restore round N of the current match/map | `css_restore N` | Only while a match is live. Loads `MatchZyDataBackup/matchzy_<matchid>_<map#>_roundNN.json`; match is paused afterwards -> `css_forceunpause`. |
| List backups | `matchzy_listbackups [matchid]` | Defaults to the live match id. One line per backup (info or file name). |
| Load a backup file | `matchzy_loadbackup matchzy_<matchid>_<map#>_round<NN>.json` | File in `csgo/MatchZyDataBackup/`. |
| Load backup from URL | `matchzy_loadbackup_url "<url>"` | Console-only. |

### Status / diagnostics
| Command | Output |
|---|---|
| `get5_status` | One JSON line: `plugin_version`, `gamestate` (`none`, `pre_veto`, `veto`, `warmup`, `knife`, `waiting_for_knife_decision`, `going_live`, `live`, `pending_restore`, `post_game`), `paused`; when a match is loaded also `loaded_config_file`, `matchid`, `map_number`, `team1`/`team2` (`name`, `series_score`, `current_map_score`, `connected_clients`, `ready`, `side`), `maps` (from going_live), `round_number` (live). Keys verified in G5API.cs. Note: in practice mode / no match loaded gamestate is `none` or `warmup`; MatchZy has no status key for practice, so the panel should track the mode it set. |
| `status` | Valve player list / map. |
| `css_plugins list`, `meta list` | Verify CSS / MatchZy / SteamGroupAdmins / Metamod are loaded. |
| `say MESSAGE` | Chat message from "Console". |

## Ports / networking

* 27015/udp (game) must be port-forwarded. 27015/tcp is RCON - published on the LAN by compose, **do not forward it**.
* CSTV (27020/udp) is enabled only for demo recording and is not published.
* `web` reaches RCON as `cs2:27015` and MatchZy reaches `web:8080` over the compose network.

## Unverified / open issues

1. No image build or game boot was possible here (no Docker daemon, no 60 GB download). The installer was tested
   against the real release archives with a fake `gameinfo.gi` (install, idempotent second run, token validation).
   First real boot should be checked with `meta list` and `css_plugins list`.
2. `de_cache` internal map name assumed (Cache was re-added to the game in April 2026 and to Active Duty in July 2026).
3. Whether RCON replies include output printed by CSS plugins (`get5_status`, `matchzy_listbackups`) - normally yes
   for CS2 console output during the RCON command, but verify on the live server.
4. CSTV takes a player slot (A2S shows it as a bot), so the default is `CS2_MAXPLAYERS=13`: 5v5 + 2 coaches + CSTV.
5. CSS `core.json` is left at its defaults (`FollowCS2ServerGuidelines: true`, gamedata auto-update on). MatchZy did
   not document needing it off.
6. Host folders must be writable by uid 1000 (see `unraid/README.md`); the wrapper exits with a clear message otherwise.
7. Passwords (`RCON_PASSWORD`, `SERVER_PASSWORD`) are limited to `[A-Za-z0-9._+=@%-]` because the base image puts
   them through `sed` and `eval`. `MATCHZY_EVENTS_TOKEN` is limited to `[A-Za-z0-9._~+=-]`.
