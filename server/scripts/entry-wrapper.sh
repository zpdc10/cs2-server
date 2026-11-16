#!/bin/bash
# Container CMD. Runs before the base image's entry.sh (joedwards32/cs2).
#
# entry.sh only copies /etc/pre.sh into the volume when ${STEAMAPPDIR}/pre.sh does not exist yet, so an
# old copy would survive image upgrades. We overwrite it on every start with our own hook, which entry.sh
# sources AFTER steamcmd has updated the game (the right moment to re-patch gameinfo.gi and copy plugins).
set -euo pipefail

: "${STEAMAPPDIR:=/home/steam/cs2-dedicated}"

if ! mkdir -p "${STEAMAPPDIR}" 2>/dev/null || ! touch "${STEAMAPPDIR}/.write-test" 2>/dev/null; then
    echo "[cs2-stack] ERROR: ${STEAMAPPDIR} is not writable by uid $(id -u)." >&2
    echo "[cs2-stack] On the host run: chown -R 1000:1000 \"\${APPDATA}/cs2-data\" \"\${APPDATA}/demos\"" >&2
    exit 1
fi
rm -f "${STEAMAPPDIR}/.write-test"

cp -f /opt/cs2-stack/scripts/pre.sh "${STEAMAPPDIR}/pre.sh"

# Passwords go through the base image's sed template rendering AND an `eval`ed command line, so characters
# like / & \ " ' $ ` ; or spaces would break them (or worse). Only allow a safe character set.
if [[ -z "${CS2_RCONPW:-}" || "${CS2_RCONPW}" == "changeme" ]]; then
    echo "[cs2-stack] ERROR: RCON_PASSWORD is not set (or still 'changeme'). Set it in .env." >&2
    exit 1
fi
for v in CS2_RCONPW CS2_PW; do
    if [[ -n "${!v:-}" && ! "${!v}" =~ ^[A-Za-z0-9._+=@%-]+$ ]]; then
        echo "[cs2-stack] ERROR: $v may only contain letters, digits and . _ + = @ % -" >&2
        exit 1
    fi
done
# The server name is only used in the sed-rendered server.cfg: escape the sed specials (\ / &).
if [[ -n "${CS2_SERVERNAME:-}" ]]; then
    n="${CS2_SERVERNAME//\"/}"; n="${n//\\/\\\\}"; n="${n//\//\\/}"; n="${n//&/\\&}"
    export CS2_SERVERNAME="$n"
fi

exec bash /home/steam/entry.sh
