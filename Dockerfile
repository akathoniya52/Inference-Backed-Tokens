# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json ./
RUN corepack enable && corepack prepare --activate

# deps: install from manifests only so the layer caches across source edits
FROM base AS deps
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/keeper/package.json apps/keeper/
COPY apps/mock-upstream/package.json apps/mock-upstream/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/chain/package.json packages/chain/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile

# build: compile the server packages, then drop dev dependencies
FROM deps AS build
COPY . .
RUN pnpm --filter @ibt/shared --filter @ibt/db --filter @ibt/chain --filter @ibt/api --filter @ibt/keeper --filter @ibt/mock-upstream build \
  && pnpm prune --prod

# runtime: one image, start command picks api or keeper
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4000 4001
CMD ["node", "apps/api/dist/main.js"]
