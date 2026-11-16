#!/bin/bash
# Idempotent installer for Metamod:Source + CounterStrikeSharp + MatchZy + SteamGroupAdmins and our cfgs.
# Called from pre.sh on every container start, after steamcmd has updated the game. Safe to run repeatedly:
#  - the large plugin trees are only (re)copied when the image's pinned versions differ from what is installed
#    (or a key file is missing);
#  - gameinfo.gi is re-patched whenever a CS2 update has reset it;
#  - our own small files (SteamGroupAdmins, *_override.cfg) are refreshed every start.
set -euo pipefail

log() { echo "[cs2-stack] $*"; }
die() { echo "[cs2-stack] ERROR: $*" >&2; exit 1; }

: "${STEAMAPPDIR:=/home/steam/cs2-dedicated}"
CSGO="${STEAMAPPDIR}/game/csgo"
STACK="${CS2_STACK_DIR:-/opt/cs2-stack}"   # overridable for local testing
DIST="${STACK}/dist"
CFG_SRC="${STACK}/cfg"
ADDONS="${CSGO}/addons"
CSS_DIR="${ADDONS}/counterstrikesharp"
MARKER="${ADDONS}/.cs2-stack-versions"

[[ -f "${CSGO}/gameinfo.gi" ]] || die "${CSGO}/gameinfo.gi not found - did the steamcmd download fail?"
mkdir -p "${ADDONS}" "${CSGO}/cfg"

# ---------------------------------------------------------------------------------------------------
# 1. Metamod + CounterStrikeSharp + MatchZy (only when versions changed or files are missing)
# ---------------------------------------------------------------------------------------------------
need_install=0
if ! cmp -s "${DIST}/VERSIONS" "${MARKER}"; then need_install=1; fi
for f in "${ADDONS}/metamod/bin/linuxsteamrt64/metamod.2.cs2.so" \
         "${ADDONS}/metamod/counterstrikesharp.vdf" \
         "${CSS_DIR}/bin/linuxsteamrt64/counterstrikesharp.so" \
         "${CSS_DIR}/plugins/MatchZy/MatchZy.dll"; do
    [[ -e "$f" ]] || need_install=1
done

if [[ ${need_install} -eq 1 ]]; then
    log "Installing $(tr '\n' ' ' < "${DIST}/VERSIONS")"
    # Remove only version-specific binaries; keep configs/ (core.json, admins), plugin configs, MatchZy data in cfg/.
    rm -rf "${ADDONS}/metamod/bin" \
           "${CSS_DIR}/bin" "${CSS_DIR}/api" "${CSS_DIR}/dotnet" \
           "${CSS_DIR}/plugins/MatchZy"
    cp -rf "${DIST}/metamod/addons/." "${ADDONS}/"
    cp -rf "${DIST}/css/addons/."     "${ADDONS}/"
    cp -rf "${DIST}/matchzy/addons/." "${ADDONS}/"
    # MatchZy's stock cfgs (cfg/MatchZy/*.cfg). Our settings live in *_override.cfg, copied below.
    # No-clobber: never overwrite operator-edited MatchZy files (admins.json, whitelist, database.json...).
    cp -rn "${DIST}/matchzy/cfg/."    "${CSGO}/cfg/"
    cp -f "${DIST}/VERSIONS" "${MARKER}"
else
    log "Metamod/CSS/MatchZy already at $(tr '\n' ' ' < "${MARKER}")"
fi

# ---------------------------------------------------------------------------------------------------
# 2. SteamGroupAdmins (built in the image from plugins/SteamGroupAdmins) - refreshed every start
# ---------------------------------------------------------------------------------------------------
if [[ -f "${DIST}/SteamGroupAdmins/SteamGroupAdmins.dll" ]]; then
    # Keep members_cache.json / granted.json so admins still work after a restart while Steam is down.
    mkdir -p "${CSS_DIR}/plugins/SteamGroupAdmins"
    find "${CSS_DIR}/plugins/SteamGroupAdmins" -maxdepth 1 -type f ! -name '*.json' -delete
    cp -rf "${DIST}/SteamGroupAdmins/." "${CSS_DIR}/plugins/SteamGroupAdmins/"
    log "SteamGroupAdmins installed"
else
    log "WARNING: SteamGroupAdmins.dll missing from the image; Steam group admins will not work"
fi
[[ -n "${STEAM_GROUP_ID:-}" ]] || log "WARNING: STEAM_GROUP_ID is empty; nobody will get admin from the Steam group"

# ---------------------------------------------------------------------------------------------------
# 3. gameinfo.gi: load Metamod. CS2 updates (and steamcmd validate) restore the stock file, so check every start.
# ---------------------------------------------------------------------------------------------------
GI="${CSGO}/gameinfo.gi"
if grep -qE '^[[:space:]]*Game[[:space:]]+csgo/addons/metamod' "${GI}"; then
    log "gameinfo.gi already loads Metamod"
else
    grep -q 'Game_LowViolence' "${GI}" || die "gameinfo.gi has no Game_LowViolence line; Valve changed the format"
    tmp="$(mktemp)"
    awk '{ print } /Game_LowViolence/ && !done { print "\t\t\tGame\tcsgo/addons/metamod"; done = 1 }' "${GI}" > "${tmp}"
    cat "${tmp}" > "${GI}"   # keep the original file's inode/permissions
    rm -f "${tmp}"
    grep -qE '^[[:space:]]*Game[[:space:]]+csgo/addons/metamod' "${GI}" || die "failed to patch gameinfo.gi"
    log "gameinfo.gi patched to load Metamod"
fi

# ---------------------------------------------------------------------------------------------------
# 4. Our MatchZy override cfgs (rendered with env values) - refreshed every start
# ---------------------------------------------------------------------------------------------------
EVENTS_URL="${MATCHZY_REMOTE_LOG_URL:-http://web:8080/api/matchzy/events}"
EVENTS_TOKEN="${MATCHZY_EVENTS_TOKEN:-}"
if [[ -z "${EVENTS_TOKEN}" ]]; then
    log "WARNING: MATCHZY_EVENTS_TOKEN is empty; the web panel will reject MatchZy events"
elif [[ ! "${EVENTS_TOKEN}" =~ ^[A-Za-z0-9._~+=-]+$ ]]; then
    die "MATCHZY_EVENTS_TOKEN may only contain letters, digits and . _ ~ + = - (it is written into a cfg file)"
fi
[[ "${EVENTS_URL}" =~ ^https?://[^\"\;[:space:]]+$ ]] || die "MATCHZY_REMOTE_LOG_URL is not a plain http(s) URL"

mkdir -p "${CSGO}/cfg/MatchZy"
for src in "${CFG_SRC}"/MatchZy/*.cfg; do
    dst="${CSGO}/cfg/MatchZy/$(basename "${src}")"
    # Plain string replacement in bash (no sed), values were validated above.
    content="$(< "${src}")"
    content="${content//\{\{MATCHZY_REMOTE_LOG_URL\}\}/${EVENTS_URL}}"
    content="${content//\{\{MATCHZY_EVENTS_TOKEN\}\}/${EVENTS_TOKEN}}"
    printf '%s\n' "${content}" > "${dst}"
done
chmod 0640 "${CSGO}/cfg/MatchZy/config_override.cfg" 2>/dev/null || true
log "MatchZy override cfgs written"

# ---------------------------------------------------------------------------------------------------
# 5. Shared demo folder (host ${APPDATA}/demos is bind-mounted here; web mounts it read-only)
# ---------------------------------------------------------------------------------------------------
mkdir -p "${CSGO}/MatchZy_demos"
[[ -w "${CSGO}/MatchZy_demos" ]] || die "${CSGO}/MatchZy_demos is not writable (chown 1000:1000 \${APPDATA}/demos on the host)"

log "Plugin install done"
