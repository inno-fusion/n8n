ARG NODE_VERSION=24.14.1
ARG N8N_VERSION=snapshot

FROM node:${NODE_VERSION}-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV CI=true
ENV NODE_OPTIONS=--max-old-space-size=8192

RUN apk add --no-cache python3 make g++ git libc6-compat \
 && corepack enable

WORKDIR /app
COPY . .

RUN git init \
 && git config user.email dyaus@inno-fusion.com \
 && git config user.name Dyaus

RUN pnpm install --frozen-lockfile
RUN pnpm build --summarize
RUN printf 'Third-party license report generation was skipped during automated fork build.\n' > packages/cli/THIRD_PARTY_LICENSES.md
RUN NODE_ENV=production DOCKER_BUILD=true pnpm --filter=n8n --prod --legacy deploy --no-optional ./compiled \
 && cp packages/cli/THIRD_PARTY_LICENSES.md compiled/THIRD_PARTY_LICENSES.md

FROM node:${NODE_VERSION}-alpine AS builder
RUN apk add --no-cache python3 make g++
COPY --from=build /app/compiled /usr/local/lib/node_modules/n8n
RUN cd /usr/local/lib/node_modules/n8n \
 && npm rebuild sqlite3 isolated-vm \
 && chmod -R a+rX /usr/local/lib/node_modules/n8n

FROM n8nio/base:${NODE_VERSION}

ARG N8N_VERSION
ARG N8N_RELEASE_TYPE=dev
ENV NODE_ENV=production
ENV N8N_RELEASE_TYPE=${N8N_RELEASE_TYPE}
ENV SHELL=/bin/sh

WORKDIR /home/node

COPY --from=builder /usr/local/lib/node_modules/n8n /usr/local/lib/node_modules/n8n
COPY --from=build /app/compiled/THIRD_PARTY_LICENSES.md /THIRD_PARTY_LICENSES.md
COPY docker/images/n8n/docker-entrypoint.sh /

RUN chmod 755 /docker-entrypoint.sh \
 && ln -s /usr/local/lib/node_modules/n8n/bin/n8n /usr/local/bin/n8n \
 && mkdir -p /home/node/.n8n \
 && chown -R node:node /home/node \
 && rm -rf /root/.npm /tmp/*

EXPOSE 5678/tcp
USER node
ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]

LABEL org.opencontainers.image.title="n8n" \
      org.opencontainers.image.description="Workflow Automation Tool" \
      org.opencontainers.image.source="https://github.com/n8n-io/n8n" \
      org.opencontainers.image.url="https://n8n.io" \
      org.opencontainers.image.version=${N8N_VERSION}
