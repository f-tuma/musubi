FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
RUN corepack enable
WORKDIR /repo

# Build a portable API production closure from the workspace lockfile. `deploy`
# isolates the selected package's peer graph, so Drizzle's client-side
# expo-sqlite context cannot pull Expo/React Native into the server image.
# Injecting workspace packages is scoped to deployment; local development keeps
# normal linked workspaces. `--prod` excludes drizzle-kit, Turbo, TypeScript and
# @types. The runtime still contains tsx and drizzle-orm for source execution
# and boot-time migrations.
FROM base AS deploy
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY patches patches
COPY apps/api apps/api
COPY packages/calendar packages/calendar
COPY packages/db packages/db
COPY packages/auth packages/auth
COPY packages/types packages/types
COPY packages/sync-codec packages/sync-codec
COPY packages/provider-google packages/provider-google
COPY packages/provider-caldav packages/provider-caldav
COPY packages/provider-microsoft packages/provider-microsoft
COPY packages/sync-runtime packages/sync-runtime
COPY packages/config packages/config
COPY packages/emails packages/emails
RUN pnpm --config.inject-workspace-packages=true --filter @musubi/api \
      deploy --prod --frozen-lockfile /prod/api

# Runtime carries only the portable deployment (no pnpm store, Corepack, client,
# docs, or monorepo source tree). Migrations execute from the injected db
# package before the API starts.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
USER root
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx
WORKDIR /app
COPY --from=deploy /prod/api /app
COPY LICENSE /app/LICENSE
RUN mkdir -p /app/data/media && chown -R node:node /app/data
ENV NODE_ENV=production

ARG API_SERVER_PORT=7531
EXPOSE ${API_SERVER_PORT} 9464
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_SERVER_PORT||7531)+'/api/v1/server/ok').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node

# The API acquires its singleton lock before applying migrations, then holds it.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
