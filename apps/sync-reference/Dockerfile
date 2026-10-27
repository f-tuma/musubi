FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS deploy
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY patches patches
COPY apps/sync-reference apps/sync-reference
COPY packages/types packages/types
COPY packages/sync-codec packages/sync-codec
COPY packages/provider-google packages/provider-google
COPY packages/provider-caldav packages/provider-caldav
COPY packages/provider-microsoft packages/provider-microsoft
COPY packages/sync-runtime packages/sync-runtime
RUN pnpm --config.inject-workspace-packages=true --filter @musubi/sync-reference deploy --prod --frozen-lockfile /prod/reference

FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
WORKDIR /app
COPY --from=deploy /prod/reference /app
COPY LICENSE /app/LICENSE
USER node
ENTRYPOINT ["node_modules/.bin/tsx", "src/cli.ts"]
CMD ["show"]
