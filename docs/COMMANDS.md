# In-game chat commands

Type these in chat. **Admin** = member of the Steam group (gets `@css/root`). **Everyone** = any player.
None of them restart the server.

## Switching modes and maps (admin)
| Command | What it does | Notes |
|---|---|---|
| `.prac` | Practice mode | Refused while a match is live: `.endmatch` first |
| `.match` / `.exitprac` | Back to scrim/match mode (warmup + ready-up) | |
| `.dm` / `.dm team` | Deathmatch: free for all / team (respawn, random spawns, buy anywhere, $16000 every life) | Leave with `.prac` or `.match`. Stays on across map changes. Refused while a scrim is loaded or live: `.endmatch` first. Also on the web Control page |
| `.map <name>` | Change map, e.g. `.map inferno` or `.map de_inferno` | Refused while a match is live |
| `.start` / `.forcestart` | Force-start the match | |
| `.endmatch` | Cancel the current match | |
| `.restart` / `.rr` | Reset to warmup | |
| `.restore <round>` | Restore a round backup (match pauses afterwards) | |
| `.forcepause` / `.forceunpause` | Admin pause | |
| `.readyrequired <n>` | Players needed to auto-start | |

## Scrim (everyone)
| Command | What it does |
|---|---|
| `.ready` / `.r`, `.unready` / `.ur` | Ready up / cancel |
| `.pause` / `.tech` | Technical pause (both teams `.unpause`) |
| `.tac` | Tactical timeout |
| `.unpause` / `.up` | Agree to unpause |
| `.stay` / `.switch` | Knife-round winner picks sides |
| `.coach t` / `.coach ct`, `.uncoach` | Become / stop being a coach |

## Practice mode (everyone, only while `.prac` is on)
| Command | What it does |
|---|---|
| `.noclip` / `.nc` | Toggle noclip (PracticeExtras plugin; console `noclip` also works) |
| `.rethrow` / `.rt`, `.last` | Rethrow your last grenade / go back to where you threw it |
| `.clear` | Remove smokes and fires |
| `.bot`, `.cbot`, `.boost`, `.nobots` | Place bots |
| `.god`, `.ff`, `.timer`, `.spawn <n>`, `.bestspawn` | Utility helpers |
| `.dryrun` | Practice a round with match settings |

Full MatchZy list: https://shobhit-pathak.github.io/MatchZy/
