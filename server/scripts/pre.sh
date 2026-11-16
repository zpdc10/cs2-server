#!/bin/bash
# Pre hook: SOURCED by the base image's entry.sh after steamcmd update, before cs2 starts
# (cwd = ${STEAMAPPDIR}/game). Copied into the volume by entry-wrapper.sh on every start; edit the
# repo copy (server/scripts/pre.sh), not the one in the volume.
#
# Run the installer in a child shell so its `set -e` / variables don't leak into entry.sh.
if ! bash /opt/cs2-stack/scripts/install-plugins.sh; then
    echo "[cs2-stack] ERROR: plugin install failed; refusing to start a server without MatchZy." >&2
    exit 1
fi
