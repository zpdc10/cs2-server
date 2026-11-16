# syntax=docker/dockerfile:1
# CS2 web panel - Node 22 LTS, zero runtime npm dependencies (uses node:sqlite).

ARG NODE_IMAGE=node:22.23-alpine3.24

# ---- build/test stage --------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
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
RUN mkdir -p /data/web /data/demos && chown node:node /data/web
USER node
EXPOSE 8080
VOLUME ["/data/web"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
