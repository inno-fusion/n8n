ARG NODE_VERSION=26.7.0
ARG N8N_VERSION=snapshot
ARG BUILDER_IMAGE=node:26.7.0-alpine3.24@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
ARG RUNTIME_IMAGE=n8nio/base:26.7.0@sha256:33687300c4e94dc00f42ec79ae15082ae07330ecd82ae1167125905b65908ff8

FROM ${BUILDER_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV CI=true
ENV NODE_OPTIONS=--max-old-space-size=8192

RUN apk add --no-cache bash python3 make g++ git libc6-compat \
 && npm install --global pnpm@12.4.2

WORKDIR /app
COPY . .

RUN git init \
 && git config user.email dyaus@inno-fusion.com \
 && git config user.name Dyaus

RUN test "$(node -p 'require("./package.json").packageManager')" = "pnpm@$(pnpm --version)" \
 && pnpm install --frozen-lockfile
RUN pnpm build --summarize --concurrency=2
# Use the release deploy path. It keeps workspace packages and runtime assets intact.
RUN N8N_GENERATE_LICENSES=false pnpm build:deploy \
 && node scripts/fork-runtime-licenses.mjs compiled

# Build native modules for the exact runtime Node/Alpine ABI.
FROM ${BUILDER_IMAGE} AS native-builder
RUN apk add --no-cache python3 make g++ librdkafka-dev
ENV NODE_GYP=/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js

COPY --from=build /app/compiled/node_modules/.pnpm/isolated-vm@*/node_modules/isolated-vm /build/isolated-vm
WORKDIR /build/isolated-vm
RUN rm -rf prebuilds && node "$NODE_GYP" rebuild --release -j max

COPY --from=build /app/compiled/node_modules/.pnpm/sqlite3@*/node_modules/node-addon-api /build/node_modules/node-addon-api
COPY --from=build /app/compiled/node_modules/.pnpm/sqlite3@*/node_modules/tar /build/node_modules/tar
COPY --from=build /app/compiled/node_modules/.pnpm/tar@*/node_modules/@isaacs/fs-minipass /build/node_modules/@isaacs/fs-minipass
COPY --from=build /app/compiled/node_modules/.pnpm/tar@*/node_modules/chownr /build/node_modules/chownr
COPY --from=build /app/compiled/node_modules/.pnpm/tar@*/node_modules/minipass /build/node_modules/minipass
COPY --from=build /app/compiled/node_modules/.pnpm/tar@*/node_modules/minizlib /build/node_modules/minizlib
COPY --from=build /app/compiled/node_modules/.pnpm/tar@*/node_modules/yallist /build/node_modules/yallist
COPY --from=build /app/compiled/node_modules/.pnpm/sqlite3@*/node_modules/sqlite3 /build/node_modules/sqlite3
WORKDIR /build/node_modules/sqlite3
RUN node "$NODE_GYP" rebuild --release

COPY --from=build /app/compiled/node_modules/.pnpm/@confluentinc+kafka-javascript@*/node_modules/nan /build/node_modules/nan
COPY --from=build /app/compiled/node_modules/.pnpm/@confluentinc+kafka-javascript@*/node_modules/@confluentinc/kafka-javascript /build/node_modules/@confluentinc/kafka-javascript
WORKDIR /build/node_modules/@confluentinc/kafka-javascript
RUN BUILD_LIBRDKAFKA=0 node "$NODE_GYP" rebuild --release

FROM ${RUNTIME_IMAGE}

ARG N8N_VERSION
ARG N8N_RELEASE_TYPE=dev
ENV NODE_ENV=production
ENV N8N_RELEASE_TYPE=${N8N_RELEASE_TYPE}
ENV SHELL=/bin/sh

WORKDIR /home/node

COPY --from=build /app/compiled /usr/local/lib/node_modules/n8n
COPY --from=build /app/compiled/THIRD_PARTY_LICENSES.md /THIRD_PARTY_LICENSES.md
COPY docker/images/n8n/docker-entrypoint.sh /

COPY --from=native-builder /build/node_modules/sqlite3/build/Release/node_sqlite3.node \
     /usr/local/lib/node_modules/n8n/node_modules/sqlite3/build/Release/node_sqlite3.node
COPY --from=native-builder /build/isolated-vm/build/Release/isolated_vm.node \
     /usr/local/lib/node_modules/n8n/node_modules/isolated-vm/build/Release/isolated_vm.node
COPY --from=native-builder /build/node_modules/@confluentinc/kafka-javascript/build/Release/confluent-kafka-javascript.node /tmp/

RUN set -e; \
    N8N=/usr/local/lib/node_modules/n8n; \
    kafka=$(echo "$N8N"/node_modules/.pnpm/@confluentinc+kafka-javascript@*/node_modules/@confluentinc/kafka-javascript); \
    install -D /tmp/confluent-kafka-javascript.node "$kafka/build/Release/confluent-kafka-javascript.node"; \
    rm -rf "$N8N"/node_modules/.pnpm/isolated-vm@*/node_modules/isolated-vm/prebuilds; \
    chmod -R a+rX "$N8N"; \
    chmod 755 /docker-entrypoint.sh; \
    mkdir -p /usr/local/bin; \
    ln -s "$N8N/bin/n8n" /usr/local/bin/n8n; \
    mkdir -p /home/node/.n8n; \
    chown -R node:node /home/node; \
    rm -rf /root/.npm /tmp/*

EXPOSE 5678/tcp
USER node
ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]

LABEL org.opencontainers.image.title="n8n" \
      org.opencontainers.image.description="Workflow Automation Tool" \
      org.opencontainers.image.source="https://github.com/inno-fusion/n8n" \
      org.opencontainers.image.url="https://n8n.io" \
      org.opencontainers.image.version=${N8N_VERSION}
