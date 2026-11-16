# DeathmatchMode

Small CounterStrikeSharp plugin (built from source in `server/Dockerfile`, MIT like the rest of the repo) that adds a
deathmatch mode you can switch to and from live, like MatchZy's `.prac` / `.match`. No restart, no map reload.

## Commands

| Command | Who | What |
|---|---|---|
| `.dm`, `.deathmatch`, `!dm`, `css_dm` | admins (`@css/map`, which `@css/root` from SteamGroupAdmins covers) | Free-for-all deathmatch |
| `.dm team`, `css_dm team` | admins | Team deathmatch (no friendly fire) |
| `.prac` / `.match` / `.exitprac` (MatchZy) | admins | Leave deathmatch; all normal settings come back |
| `css_dm_status` | server / RCON | Prints `deathmatch=on|off variant=ffa|team` (the web panel uses it) |

Deathmatch: respawn on death, random spawns (the deathmatch spawn points of Valve maps), 2 s spawn protection, buy
anywhere at any time, $16000 every life, kevlar + helmet, infinite reserve ammo, no C4, 30 minute rounds that roll over.
It stays on across map changes (`.map`, web "Change map") until someone switches to practice or match mode.
It cannot start while a match is running (knife round or live): cancel the match first.

## How it works

It uses the normal competitive game mode plus cvars, and MatchZy's built-in "sleep" mode (MatchZy idle):

1. `.dm` runs `css_match; css_sleep`. `css_match` ends practice mode the MatchZy way (bots, spawn markers, cheats) and
   does nothing in match warmup; MatchZy refuses `css_sleep` while a match is running.
2. MatchZy execs its `sleep.cfg` (a full competitive baseline) and then our `MatchZy/sleep_override.cfg`, which execs
   `cs2-stack/deathmatch.cfg`: deathmatch cvars, `matchzy_autostart_mode 0` (so a map change re-enters sleep, i.e.
   deathmatch) and `css_dm_entered` (plugin: chat message, team/FFA, money refill on spawn).
3. `.prac` / `.match` / loading a scrim make MatchZy exec `prac.cfg` or `warmup.cfg`, then our `prac_override.cfg` /
   `warmup_override.cfg`, which exec `cs2-stack/deathmatch_off.cfg`. That file resets exactly the deathmatch cvars that
   MatchZy's cfgs don't set, puts `matchzy_autostart_mode` back to 1 and calls `css_dm_exited`.

Files: `server/cfg/cs2-stack/deathmatch*.cfg`, `server/cfg/MatchZy/{sleep,warmup,prac}_override.cfg`.
When adding a cvar to `deathmatch.cfg`, also reset it in `deathmatch_off.cfg` unless both MatchZy's `warmup.cfg` and
`prac.cfg` set it (if only one does, reset it in the other one's `*_override.cfg`).
