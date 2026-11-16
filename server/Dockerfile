# syntax=docker/dockerfile:1
#
# CS2 dedicated server + Metamod:Source + CounterStrikeSharp + MatchZy + SteamGroupAdmins.
#
# Build context is the REPO ROOT (docker-compose.yml: build.context ".", dockerfile "server/Dockerfile"),
# because the SteamGroupAdmins plugin source lives in plugins/.
#
# The game itself (~60 GB) is NOT in the image: the base image's entry.sh downloads/updates it with
# steamcmd into the /home/steam/cs2-dedicated volume on every start. Plugins are baked into the image
# under /opt/cs2-stack and copied into the game dir by server/scripts/install-plugins.sh, which runs from
# the base image's pre.sh hook, i.e. AFTER each steamcmd update (so gameinfo.gi is re-patched after CS2 updates).
#
# All versions below were verified against the upstream GitHub releases on 2026-11-16.
# To upgrade: bump version + sha256 (sha256sum of the release asset), rebuild.

ARG CS2_BASE_IMAGE=joedwards32/cs2:5.0.1
ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0

# ---------------------------------------------------------------------------------------------------
# Stage 1: build the custom SteamGroupAdmins CounterStrikeSharp plugin (net10.0, CSS API 1.0.380)
# ---------------------------------------------------------------------------------------------------
FROM ${DOTNET_SDK_IMAGE} AS plugin-build
WORKDIR /src
COPY plugins/SteamGroupAdmins/ plugins/SteamGroupAdmins/
RUN dotnet publish plugins/SteamGroupAdmins -c Release -o /out/SteamGroupAdmins \
 && rm -f /out/SteamGroupAdmins/CounterStrikeSharp.API.dll /out/SteamGroupAdmins/*.pdb \
 && test -f /out/SteamGroupAdmins/SteamGroupAdmins.dll

# ---------------------------------------------------------------------------------------------------
# Stage 2: fetch + verify pinned release archives and unpack them into a ready-to-copy tree
# ---------------------------------------------------------------------------------------------------
FROM debian:trixie-slim AS fetch

# Metamod:Source 2.0 dev build (CS2 needs 2.0; binary addons/metamod/bin/linuxsteamrt64/metamod.2.cs2.so)
ARG METAMOD_BUILD=1491
ARG METAMOD_SHA256=e15487e34817214d158f8ad830e1ebe0f22ea990f07c8912a89abc2a9ed67863
# CounterStrikeSharp "with-runtime" (bundles the .NET 10.0.3 runtime) - MatchZy 0.9.3 needs >= v369
ARG CSS_VERSION=1.0.380
ARG CSS_SHA256=f0653332a517c9edbaf8d6bfeb2ffec5aa730638ebd5e568d9753fa1063ba68e
# MatchZy
ARG MATCHZY_VERSION=0.9.3
ARG MATCHZY_SHA256=f5b7d59097f87e5136f37cbf22fb0aff9c6f72067b2ceef532cbd972cd5c60a3

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /dl
RUN set -eux; \
    curl -fsSL -o mm.tar.gz "https://github.com/alliedmodders/metamod-source/releases/download/2.0.0.${METAMOD_BUILD}/mmsource-2.0.0-git${METAMOD_BUILD}-linux.tar.gz"; \
    curl -fsSL -o css.zip   "https://github.com/roflmuffin/CounterStrikeSharp/releases/download/v${CSS_VERSION}/counterstrikesharp-with-runtime-linux-${CSS_VERSION}.zip"; \
    curl -fsSL -o mz.zip    "https://github.com/shobhit-pathak/MatchZy/releases/download/${MATCHZY_VERSION}/MatchZy-${MATCHZY_VERSION}.zip"; \
    echo "${METAMOD_SHA256}  mm.tar.gz" | sha256sum -c -; \
    echo "${CSS_SHA256}  css.zip"       | sha256sum -c -; \
    echo "${MATCHZY_SHA256}  mz.zip"    | sha256sum -c -; \
    mkdir -p /dist/metamod /dist/css /dist/matchzy; \
    tar -xzf mm.tar.gz -C /dist/metamod; \
    unzip -q css.zip -d /dist/css; \
    unzip -q mz.zip  -d /dist/matchzy; \
    test -f /dist/metamod/addons/metamod/bin/linuxsteamrt64/metamod.2.cs2.so; \
    test -f /dist/css/addons/metamod/counterstrikesharp.vdf; \
    test -f /dist/matchzy/addons/counterstrikesharp/plugins/MatchZy/MatchZy.dll; \
    printf 'metamod=2.0.0-git%s\ncss=%s\nmatchzy=%s\n' "${METAMOD_BUILD}" "${CSS_VERSION}" "${MATCHZY_VERSION}" > /dist/VERSIONS

# ---------------------------------------------------------------------------------------------------
# Stage 3: final image = upstream CS2 image + our files
# ---------------------------------------------------------------------------------------------------
FROM ${CS2_BASE_IMAGE}

USER root
COPY --from=fetch        /dist                     /opt/cs2-stack/dist
COPY --from=plugin-build /out/SteamGroupAdmins     /opt/cs2-stack/dist/SteamGroupAdmins
COPY server/cfg/                                   /opt/cs2-stack/cfg/
COPY server/scripts/                               /opt/cs2-stack/scripts/
# Our server.cfg template replaces the image's /etc/server.cfg (same {{PLACEHOLDERS}}, entry.sh renders it).
COPY server/cfg/server.cfg                         /etc/server.cfg
RUN chmod 0755 /opt/cs2-stack/scripts/*.sh \
 && chmod -R a+rX /opt/cs2-stack /etc/server.cfg

# Back to the image's unprivileged user (uid/gid 1000 "steam")
USER 1000:1000
WORKDIR /home/steam

# Competitive defaults (all overridable from docker-compose / .env)
ENV CS2_MAXPLAYERS=12 \
    CS2_GAMETYPE=0 \
    CS2_GAMEMODE=1 \
    CS2_MAPGROUP=mg_active \
    CS2_STARTMAP=de_mirage \
    CS2_SERVER_HIBERNATE=0 \
    TV_ENABLE=1 \
    TV_AUTORECORD=0 \
    TV_DELAY=0

# Wrapper installs our pre.sh hook into the volume, then hands over to the image's entry.sh
CMD ["bash", "/opt/cs2-stack/scripts/entry-wrapper.sh"]
