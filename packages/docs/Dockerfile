FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
RUN corepack enable
WORKDIR /repo

# Build a portable docs production closure from the workspace lockfile.
# Corepack reads the exact pnpm version from the root manifest; the deployed
# package has no partial-workspace state or global pnpm installation.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages/docs packages/docs
RUN pnpm --config.inject-workspace-packages=true --filter @musubi/docs \
      deploy --prod --frozen-lockfile /prod/docs
WORKDIR /prod/docs
RUN node_modules/.bin/astro build

FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
USER root
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx
WORKDIR /app
COPY --from=build /prod/docs /app

ENV NODE_ENV=production
# @astrojs/node 11.0.2's startup banner uses app.pipeline, removed by Astro
# 7.2.3. Skip only that banner; request and error logging stay enabled.
ENV ASTRO_NODE_LOGGING=disabled
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "./dist/server/entry.mjs"]
