# Running the stack on Unraid

The stack is three containers defined in `docker-compose.yml`: `cs2` (game server), `web` (panel) and
`cloudflared` (Cloudflare Tunnel for https://cs2.zandank.com). On Unraid the easiest route is the
**Docker Compose Manager** plugin (Community Applications -> search "Compose Manager").

## 1. Prepare the host

Open a terminal on the Unraid server (or the web terminal):

```sh
# Code: clone the repo somewhere persistent (not into the docker.img)
mkdir -p /mnt/user/appdata/cs2
cd /mnt/user/appdata/cs2
git clone https://github.com/<you>/<repo>.git src

# Data folders. The cs2 container runs as uid/gid 1000, so it must own its folders.
mkdir -p /mnt/user/appdata/cs2/cs2-data /mnt/user/appdata/cs2/demos /mnt/user/appdata/cs2/web
chown -R 1000:1000 /mnt/user/appdata/cs2/cs2-data /mnt/user/appdata/cs2/demos
```

* Needs about **60 GB** free for `cs2-data`, plus room for demos (~50-150 MB per map). If `appdata` is on a small cache
  pool, set `APPDATA` to a share with enough space, or set the appdata share to use the array.
* Unraid's "New Permissions" / Docker Safe New Perms tool resets ownership to `nobody:users`; run the `chown` again
  afterwards (the cs2 container stops with a clear error if it cannot write).
* The web folder's owner depends on the web image (see `web/NOTES.md`).

## 2. Configure

```sh
cd /mnt/user/appdata/cs2/src
cp .env.example .env
nano .env          # fill SRCDS_TOKEN, RCON_PASSWORD, SESSION_SECRET, MATCHZY_EVENTS_TOKEN, STEAM_GROUP_ID, TUNNEL_TOKEN
```

`openssl rand -hex 32` makes good values for `SESSION_SECRET`, `MATCHZY_EVENTS_TOKEN` and `RCON_PASSWORD`.
Never commit `.env`.

## 3. Add the stack in Compose Manager

1. Docker tab -> Compose -> **Add New Stack**, name it `cs2`.
2. Advanced -> set the stack's directory to `/mnt/user/appdata/cs2/src` (the repo checkout), so it uses the repo's
   `docker-compose.yml` and `.env`. (Alternatively paste the compose file and `.env` contents into the stack editor;
   then the `build:` paths must point at the repo checkout with absolute paths.)
3. **Compose Up**. The first time it builds the `cs2` and `web` images, then the cs2 container downloads CS2
   (~60 GB, can take an hour). Follow it with the stack's log button or `docker logs -f cs2`.

CLI equivalent: `cd /mnt/user/appdata/cs2/src && docker compose up -d --build`.

## 4. Network

* Router: forward **UDP 27015** (and TCP 27015 is not needed from outside - RCON stays on the LAN) to the Unraid IP.
* The web panel needs no port forward: the Cloudflare Tunnel connects outwards. In Cloudflare Zero Trust ->
  Networks -> Tunnels, give the tunnel a public hostname `cs2.zandank.com` with service `http://web:8080`.
* On the LAN the panel is also at `http://<unraid-ip>:${WEB_PORT}`.

## 5. Updates

* **CS2 game update**: restart the `cs2` container. On start it runs steamcmd, then re-adds the Metamod line to
  `gameinfo.gi` and re-checks the plugins.
* **Plugin / stack update**: `git pull` in the repo, then Compose **Up** with rebuild (`docker compose up -d --build`).
  Plugin versions are pinned in `server/Dockerfile`.
* After a CS2 update, CounterStrikeSharp sometimes needs a new release (it auto-updates its gamedata, but not its
  binary). If `css_plugins list` fails after an update, bump `CSS_VERSION`/`CSS_SHA256` in `server/Dockerfile`.

## 6. Checks after first boot

`docker attach --sig-proxy=false cs2` (detach: Ctrl-P Ctrl-Q) or use RCON, then:

```
meta list            -> CounterStrikeSharp
css_plugins list     -> MatchZy, SteamGroupAdmins
```
