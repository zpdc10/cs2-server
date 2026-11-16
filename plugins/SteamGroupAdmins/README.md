# SteamGroupAdmins (CounterStrikeSharp plugin)

Makes every member of a Steam group an admin on the CS2 server by granting CounterStrikeSharp
permission flags (default `@css/root`) at runtime.

## Build

Requires the .NET 10 SDK (CounterStrikeSharp 1.0.380 targets `net10.0`).

```sh
cd plugins/SteamGroupAdmins
dotnet build -c Release
# -> bin/Release/net10.0/SteamGroupAdmins.dll
```

Install: copy `SteamGroupAdmins.dll` into
`game/csgo/addons/counterstrikesharp/plugins/SteamGroupAdmins/` on the server.

Pinned: `CounterStrikeSharp.API` **1.0.380** (NuGet, 2026-11-12), `net10.0`. The CSS API assembly is
provided by the server and is not copied to the output.

## Configuration

Group ID: environment variable **`STEAM_GROUP_ID`** (wins), otherwise `SteamGroupId` in the config file.
A numeric 64-bit ID (`103582791…`) uses `/gid/<id>/`; anything else is treated as the group's custom URL
name (`/groups/<name>/`). The group's member list must be public.

CounterStrikeSharp creates `addons/counterstrikesharp/configs/plugins/SteamGroupAdmins/SteamGroupAdmins.json`
on first load:

| Key | Default | Meaning |
|---|---|---|
| `SteamGroupId` | `""` | Fallback when `STEAM_GROUP_ID` is not set |
| `RefreshIntervalSeconds` | `300` | Re-fetch interval (minimum 60) |
| `HttpTimeoutSeconds` | `20` | Per-request timeout |
| `MaxPages` | `50` | Safety cap; Steam returns 1000 members per page |
| `Flags` | `["@css/root"]` | Flags granted to members |
| `ExtraAdmins` | `[]` | SteamID64 strings that get the same flags without being in the group |

## How it works

- Fetches `https://steamcommunity.com/gid/<id>/memberslistxml/?xml=1`, following `nextPageLink`
  (or `&p=N` up to `<totalPages>`), on a background task. Results go back to the game thread with
  `Server.NextFrame`; the game thread never waits on HTTP.
- A failed refresh (timeout, HTTP error, Steam error XML, empty list) keeps the last good list.
- Each good list is cached to `plugins/SteamGroupAdmins/members_cache.json`, so after a restart while
  Steam is down the cached members are still admins.
- Flags are granted when a player is authorized (`OnClientAuthorized`), on `player_connect_full`, and
  after every refresh, using `AdminManager.AddPlayerPermissions`.
- The plugin records only the flags **it** added (`granted.json`). Flags a player already had from
  `configs/admins.json` / admin groups are never recorded, so they are never removed. When someone leaves
  the group, only the plugin's flags are removed (`AdminManager.RemovePlayerPermissions`).
- `css_admins_reload` wipes CounterStrikeSharp's admin table; the plugin then forgets its records and
  grants again.

## Commands (server console / RCON, or a player with `@css/root`)

- `css_groupadmins_refresh`: fetch the member list now
- `css_groupadmins_status`: group, flags, member count, list source (steam/cache), last error, how many
  players have flags from this plugin

## MatchZy

MatchZy's `IsPlayerAdmin(player, command, perms...)` builds `RequiresPermissionsOr(perms + "@css/root")`,
so a player with **`@css/root`** passes every MatchZy admin check. The specific flags it asks for are
`@css/config` (most match control: forceready, restore, pause control, etc.), `@css/map` (map change, prac,
add ready time), `@css/chat` (`.asay`), `@css/rcon` (`.rcon`) and `@custom/prac`. With `@css/root`
you don't need MatchZy's own `cfg/MatchZy/admins.json`, and you don't need `matchzy_everyone_is_admin`.

If you use narrower flags instead of `@css/root`, grant at least
`["@css/config", "@css/map", "@css/chat", "@css/rcon"]`. In CounterStrikeSharp, `@css/root` also grants every
other `@css/*` flag (for CSS's built-in `css_*` admin commands).
