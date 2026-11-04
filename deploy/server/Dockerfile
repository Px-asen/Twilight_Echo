# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build pkg-config python3 ca-certificates \
    libavformat-dev libavcodec-dev libavutil-dev libswresample-dev libswscale-dev libebur128-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
RUN npm install -g pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY audio-engine ./audio-engine
RUN cmake -S audio-engine -B /native -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DTAE_BUILD_NAPI=ON -DTAE_BUILD_TESTS=OFF -DTAE_ENABLE_ALSA=OFF \
    -DTAE_NODE_INCLUDE_DIR=/source/node_modules/node-api-headers/include \
    && cmake --build /native --parallel 4 \
    && test -f /native/libtwilight-audio-engine.so \
    && test -f /native/twilight_image_node.node
COPY src ./src
COPY scripts ./scripts
COPY resources/plugins ./resources/plugins
COPY resources/remote ./resources/remote
COPY docs ./docs
COPY LICENSE ./LICENSE
RUN node scripts/build-server.cjs \
    && node scripts/stage-linux-server.cjs --to /server --native /native

FROM build AS verification
USER 1000:1000
RUN node --test --import ./scripts/register-renderer-aliases.mjs \
    src/main/server/profileCredentials.test.ts src/main/server/maintenance.test.ts \
    scripts/server-health.test.cjs scripts/server-linux.test.cjs

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini libavformat59 libavcodec59 libavutil57 libswresample4 libswscale6 libebur128-1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/twilight
COPY --from=build /server/ ./
ENV NODE_ENV=production HOME=/tmp
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/twilight/out/server/server.cjs"]
CMD ["start", "--bridge-only", "--data", "/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node /opt/twilight/out/server/server.cjs health --data /data || exit 1
