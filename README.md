# CS2 practice & scrim server

Self-hosted Counter-Strike 2 server for Unraid with practice and scrim/match modes, Steam-group admins and a web panel with public demo downloads. Everything except CS2 itself is open source.

| Part | Folder | What it does |
|---|---|---|
| Game server | `server/` | CS2 (joedwards32/cs2 image) + Metamod:Source + CounterStrikeSharp + MatchZy. Practice (`.prac`), scrims with knife round, ready-up, pauses, coaches, round restore, all 24 rounds played out, every match recorded. |
| Admin plugin | `plugins/SteamGroupAdmins/` | Gives `@css/root` to members of a public Steam group (refreshes every 5 min). |
| Web panel | `web/` | Steam login for group members to switch modes, start scrims, pause and restore rounds. Public status and demo downloads. |
| Tunnel | `docker-compose.yml` | `cloudflared` publishes the panel at `PUBLIC_URL` without opening a web port. |

## Quick start (Unraid)

1. Copy `.env.example` to `.env` and fill in the secrets (GSLT from https://steamcommunity.com/dev/managegameservers, RCON password, session secret, events token, tunnel token, `CONNECT_ADDRESS`).
2. Follow `unraid/README.md` to create the folders (owned by uid 1000) and start the stack with Compose Manager.
3. Forward UDP and TCP 27015 to the Unraid host. Point the tunnel hostname at `http://web:8080`.

Never commit `.env`: this repository is public.

More detail: `server/NOTES.md` (versions, licenses, RCON commands), `plugins/SteamGroupAdmins/README.md`, `web/NOTES.md` (routes, env vars).
