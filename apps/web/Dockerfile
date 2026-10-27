FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
RUN corepack enable
WORKDIR /repo

# The web build needs dev dependencies (Vite, the TanStack Start plugin, Nitro),
# so this stage installs the full workspace graph rather than a --prod closure
# like the API image. Only the build artifact reaches the runtime.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY patches patches
COPY apps/web apps/web
COPY packages/calendar packages/calendar
COPY packages/design-system packages/design-system
COPY packages/types packages/types
RUN pnpm --filter @musubi/web... install --frozen-lockfile
RUN pnpm --filter @musubi/web build

# Nitro emits a self-contained bundle: .output/server carries its own
# node_modules, so the runtime needs neither pnpm nor the monorepo source.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
USER root
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx
WORKDIR /app
COPY --from=build /repo/apps/web/.output /app/.output
ENV NODE_ENV=production

# The server reads PORT and binds all interfaces.
ARG PORT=3000
ENV PORT=${PORT}
EXPOSE ${PORT}
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NITRO_PORT||process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node

# No API_URL: the browser calls /api/* on the same public origin, which the
# reverse proxy routes to the API. This container never talks to the API itself.
CMD ["node", ".output/server/index.mjs"]
