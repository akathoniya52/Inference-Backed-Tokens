# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
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
# Backstop for .dockerignore: no local env file may reach the runtime image.
RUN find . -name node_modules -prune -o -name '.env*' ! -name '.env.example' -type f -exec rm -f {} +
RUN pnpm --filter @ibt/shared --filter @ibt/db --filter @ibt/chain --filter @ibt/api --filter @ibt/keeper --filter @ibt/mock-upstream build \
  && pnpm prune --prod

# runtime: one image, start command picks api or keeper
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Root-owned, so `node` cannot rewrite the app; nothing at runtime writes under /app.
COPY --from=build /app /app
USER node
EXPOSE 4000 4001
# No curl in the slim image. Healthy when the running process answers /healthz: the api on
# PORT (default 4000) or the keeper on KEEPER_PORT (default 4001).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "Promise.any([process.env.PORT||4000,process.env.KEEPER_PORT||4001].map(async(p)=>{const r=await fetch(`http://127.0.0.1:${p}/healthz`,{signal:AbortSignal.timeout(4000)});if(!r.ok)throw new Error(String(r.status))})).then(()=>process.exit(0),()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]
