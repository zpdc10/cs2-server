# DeathmatchMode

Small CounterStrikeSharp plugin (built from source in `server/Dockerfile`, MIT like the rest of the repo) that adds a
deathmatch mode you can switch to and from live, like MatchZy's `.prac` / `.match`. No restart, no map reload.

## Commands

| Command | Who | What |
|---|---|---|
| `.dm`, `.deathmatch`, `!dm`, `css_dm` | admins (`@css/map`, which `@css/root` from SteamGroupAdmins covers) | Free-for-all deathmatch |
| `.dm team`, `css_dm team` | admins | Team deathmatch (no friendly fire) |
| `.gg`, `.gungame`, `css_gg`, `css_dm gg` | admins | Gun game |
| `.level` / `.lvl` | everyone, in gun game | Shows your level and gun |
| `.prac` / `.match` / `.exitprac` (MatchZy) | admins | Leave deathmatch; all normal settings come back |
| `css_dm_status` | server / RCON | Prints `deathmatch=on|off variant=ffa|team|gg` (the web panel uses it) |

Deathmatch: respawn on death, random spawns (the deathmatch spawn points of Valve maps), 2 s spawn protection, buy
anywhere at any time, $16000 every life, kevlar + helmet, infinite reserve ammo, no C4, 30 minute rounds that roll over.
Every kill in deathmatch (not gun game) refills the magazines of all your guns and gives +25 HP and +10 armor,
each capped at 100.

Gun game (`GunGame.cs`): free for all, no buying, no money, no map-placed weapons; the plugin hands out the guns.
Every kill moves you to the next of 19 levels: the 18 guns in `GunGamePool` in a new random order every game (on start and after each win), then the knife.
Only a knife kill made on the knife level wins; then levels reset and the round restarts after 6 s. Getting knifed
sends you back one level (never below level 1). Change the guns in `GunGamePool` (no knife there; it is added last).

It stays on across map changes (`.map`, web "Change map") until someone switches to practice or match mode.
It cannot start while a match is running (knife round or live): cancel the match first.

## How it works

It uses the normal competitive game mode plus cvars, and MatchZy's built-in "sleep" mode (MatchZy idle):

1. `.dm` runs `css_match; css_sleep` (just `css_sleep` when deathmatch is already on). `css_match` ends practice mode the MatchZy way (bots, spawn markers, cheats) and
   does nothing in match warmup; MatchZy refuses `css_sleep` while a match is running.
2. MatchZy execs its `sleep.cfg` (a full competitive baseline) and then our `MatchZy/sleep_override.cfg`, which execs
   `cs2-stack/deathmatch.cfg`: deathmatch cvars, `matchzy_autostart_mode 0` (so a map change re-enters sleep, i.e.
   deathmatch) and `css_dm_entered` (plugin: chat message, team/FFA, money refill on spawn).
3. `.prac` / `.match` / loading a scrim make MatchZy exec `prac.cfg` or `warmup.cfg`, then our `prac_override.cfg` /
   `warmup_override.cfg`, which exec `cs2-stack/deathmatch_off.cfg`. That file resets exactly the deathmatch cvars that
   MatchZy's cfgs don't set, puts `matchzy_autostart_mode` back to 1 and calls `css_dm_exited`.

4. The override cfgs (and `live_override.cfg`) also call `css_dm_exited warmup|practice|live`, so the plugin knows
   which MatchZy mode runs. MatchZy never clears its internal sleep flag, which would make `.match` / `css_exitprac`
   reset plain match warmup (and a loaded scrim) after the first deathmatch; the plugin blocks exactly those cases,
   so `.match` behaves as before. `.dm` is also refused while a scrim config is loaded (until `.endmatch` or the
   match ends) or a match is live.

MatchZy's own `.sleep` / `css_sleep` now also starts deathmatch (sleep mode is only used for that here).
State is in memory: after a server or plugin restart deathmatch is off (MatchZy starts in match mode).

Files: `server/cfg/cs2-stack/deathmatch*.cfg`, `server/cfg/cs2-stack/gungame.cfg` (exec'd by the plugin after deathmatch.cfg, same reset rules), `server/cfg/MatchZy/{sleep,warmup,prac}_override.cfg`.
When adding a cvar to `deathmatch.cfg`, also reset it in `deathmatch_off.cfg` unless both MatchZy's `warmup.cfg` and
`prac.cfg` set it (if only one does, reset it in the other one's `*_override.cfg`).
