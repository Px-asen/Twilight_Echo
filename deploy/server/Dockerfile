# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS public-models
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY audio-engine/automix-native/tools ./audio-engine/automix-native/tools
COPY audio-engine/automix-native/dependencies.lock.json ./audio-engine/automix-native/dependencies.lock.json
COPY scripts/build-public-automix-assets.py ./scripts/build-public-automix-assets.py
COPY scripts/test-build-public-automix-assets.py ./scripts/test-build-public-automix-assets.py
ENV TF_USE_LEGACY_KERAS=1 TF_ENABLE_ONEDNN_OPTS=0 OMP_NUM_THREADS=4 TF_NUM_INTRAOP_THREADS=4 TF_NUM_INTEROP_THREADS=1
ENV PIP_DEFAULT_TIMEOUT=300 PIP_RETRIES=8 PIP_RESUME_RETRIES=12
RUN --mount=type=cache,target=/root/.cache/pip python -m pip install --upgrade pip==26.3
RUN --mount=type=cache,target=/root/.cache/pip python scripts/test-build-public-automix-assets.py \
    && python scripts/build-public-automix-assets.py --install-dependencies --work /model-work --output /public-graphs

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
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store --fetch-timeout 300000 --network-concurrency 4
COPY audio-engine ./audio-engine
RUN cmake -S audio-engine -B /native -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DTAE_BUILD_NAPI=ON -DTAE_BUILD_TESTS=OFF -DTAE_ENABLE_ALSA=OFF \
    -DTAE_NODE_INCLUDE_DIR=/source/node_modules/node-api-headers/include \
    && cmake --build /native --parallel 4 \
    && test -f /native/libtwilight-audio-engine.so \
    && test -f /native/twilight_image_node.node
COPY src ./src
COPY scripts ./scripts
COPY --from=public-models /public-graphs /public-graphs
RUN node scripts/stage-automix-native-assets.cjs /public-graphs /source/resources/audio-engine/automix-native
COPY resources/automix-stems/worker.py resources/automix-stems/arrangement.py resources/automix-stems/probe.py ./resources/automix-stems/
COPY resources/plugins ./resources/plugins
COPY resources/remote ./resources/remote
COPY docs ./docs
COPY LICENSE ./LICENSE
RUN node scripts/build-server.cjs \
    && node scripts/stage-linux-server.cjs --to /server --native /native

FROM build AS verification
ENV TWILIGHT_BRIDGE_NATIVE=/server/resources/audio-engine/twilight_audio_node.node \
    TWILIGHT_SYNC_SERVICE=/server/out/server/audioEngineService.cjs \
    TWILIGHT_SYNC_RESOURCES=/server/resources \
    TWILIGHT_SERVER_PACKAGE_TEST_ROOT=/server
COPY deploy/server/Dockerfile ./deploy/server/Dockerfile
USER 1000:1000
RUN node --test --import ./scripts/register-renderer-aliases.mjs \
    src/main/server/profileCredentials.test.ts src/main/server/maintenance.test.ts \
    src/main/audio/nativeBinding.test.ts scripts/server-linux-stage.test.cjs \
    scripts/server-health.test.cjs scripts/server-linux.test.cjs
RUN node --test --import ./scripts/register-renderer-aliases.mjs \
    scripts/audio-bridge-formats-native.test.cjs scripts/audio-sync-groups-native.test.cjs \
    scripts/audio-group-automix-binding-native.test.cjs scripts/audio-group-automix-coordinator-native.test.cjs \
    scripts/server-desktop-bundle.test.cjs

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
