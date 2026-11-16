# syntax=docker/dockerfile:1
# CS2 web panel - Node 22 LTS, zero runtime npm dependencies (uses node:sqlite).

ARG NODE_IMAGE=node:22.23-alpine3.24

# ---- 2D demo viewer ----------------------------------------------------------
# sparkoo/csgo-2d-demo-viewer (MIT): Go demo parser compiled to WebAssembly + Preact player.
# Pinned to a commit; bump VIEWER_REF to update (viewer/patch.mjs fails loudly if upstream changed shape).
ARG GO_IMAGE=golang:1.27-alpine
ARG VIEWER_REPO=https://github.com/sparkoo/csgo-2d-demo-viewer.git
ARG VIEWER_REF=df5a8beacb06fe1c9c898d693ed5d00c65297747
# Demo parser used by the viewer. Upstream pins v6.0.0-rc.1, which fails on current CS2 demos
# ("ErrDecodeFailed ... insufficient buffer"); rc.2 reads them. Set to "" to keep upstream's pin.
ARG DEMOINFOCS_VERSION=v6.0.0-rc.2

FROM ${GO_IMAGE} AS viewer-src
ARG VIEWER_REPO
ARG VIEWER_REF
ARG DEMOINFOCS_VERSION
RUN apk add --no-cache git \
 && git init -q /src && cd /src \
 && git fetch -q --depth 1 "$VIEWER_REPO" "$VIEWER_REF" && git checkout -q FETCH_HEAD
WORKDIR /src/parser
# Report parse failures to the page (upstream only prints them, so the player shows "Loading match..." forever).
RUN grep -q 'fmt.Printf("Failed to parse a demo: %+v \\n", err)' wasm.go \
 && sed -i 's|fmt.Printf("Failed to parse a demo: %+v \\n", err)|fmt.Printf("Failed to parse a demo: %+v \\n", err); js.Global().Call("postMessage", "parse-error:"+err.Error())|' wasm.go \
 && grep -q '"parse-error:"' wasm.go \
 && if [ -n "$DEMOINFOCS_VERSION" ]; then go get "github.com/markus-wa/demoinfocs-golang/v6@$DEMOINFOCS_VERSION"; fi
RUN mkdir -p /out/wasm \
 && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /out/wasm/csdemoparser.wasm ./wasm.go \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm/
# The same parser as a native command for the web server: it parses each stored demo once (src/replays.js).
COPY viewer/replaycli/main.go ./cmd/replay/main.go
RUN mkdir -p /out/bin \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bin/replay ./cmd/replay

FROM ${NODE_IMAGE} AS viewer
WORKDIR /src
COPY --from=viewer-src /src/web ./
COPY viewer /patch
# --ignore-scripts: no install scripts from third-party packages. The icon font replaces Google Fonts (OFL-1.1).
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm install --ignore-scripts --no-audit --no-fund --save-exact @fontsource/material-icons@5.3.0 \
 && node /patch/patch.mjs \
 && npx vite build --base /viewer/ \
 && rm -f dist/logo192.png dist/logo512.png dist/manifest.json dist/robots.txt
COPY --from=viewer-src /out/wasm ./dist/wasm
COPY --from=viewer-src /src/LICENSE ./dist/LICENSE.txt

# ---- build/test stage --------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p node_modules
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY test ./test
RUN npm run build && npm test

# ---- runtime stage -----------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data/web \
    DEMOS_DIR=/data/demos
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=viewer /src/dist ./viewer-dist
COPY --from=viewer-src /out/bin/replay ./bin/replay
RUN mkdir -p /data/web /data/demos && chown node:node /data/web
USER node
EXPOSE 8080
VOLUME ["/data/web"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
