FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS deploy
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

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runner
WORKDIR /app
COPY --from=deploy /prod/reference /app
COPY LICENSE /app/LICENSE
USER node
ENTRYPOINT ["node_modules/.bin/tsx", "src/cli.ts"]
CMD ["show"]
