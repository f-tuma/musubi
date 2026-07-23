FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo

# Install ONLY the API's production dependency closure. The workspace uses a
# hoisted node_modules for Expo/Metro (see pnpm-workspace.yaml), which would
# otherwise drag the whole mobile client + docs site into this image. Overriding
# the linker to `isolated` plus `--filter @musubi/api...` installs just the API
# and its workspace deps; `--prod` drops all build-only tooling (drizzle-kit,
# turbo, typescript, @types). Migrations run at boot via drizzle-orm's own
# migrator (packages/db/src/migrate.ts) — no drizzle-kit CLI needed at runtime.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY packages/calendar/package.json packages/calendar/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
# auto-install-peers=false stops drizzle-orm's optional peers (expo-sqlite,
# better-sqlite3, mysql2 …) from dragging the mobile client's Expo/React-Native
# tree in through peer resolution. (Optional *dependencies* like esbuild's
# platform binary are still installed — tsx needs them.) Lockfile isn't frozen
# here because we deliberately resolve a leaner tree.
RUN pnpm install --filter @musubi/api... --prod --node-linker=isolated \
      --config.auto-install-peers=false
COPY apps/api apps/api
COPY packages/calendar packages/calendar
COPY packages/db packages/db
COPY packages/auth packages/auth
COPY packages/types packages/types
COPY packages/config packages/config

# Runtime carries over only the workspace tree (no pnpm store cache, no pnpm/
# corepack — the CMD runs tsx directly).
FROM node:22-alpine AS runner
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
ENV NODE_ENV=production

ARG API_SERVER_PORT=7531
EXPOSE ${API_SERVER_PORT} 9464

# Invoke tsx directly (no pnpm/corepack at runtime — avoids a network fetch on
# boot). tsx is symlinked into the API's node_modules/.bin by the isolated linker.
CMD ["sh", "-c", "node_modules/.bin/tsx ../../packages/db/src/migrate.ts && node_modules/.bin/tsx src/index.ts"]
