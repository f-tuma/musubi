FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @musubi/api...

FROM deps AS runner
COPY apps/api apps/api
COPY packages/db packages/db
COPY packages/auth packages/auth
COPY packages/types packages/types
COPY packages/config packages/config

WORKDIR /repo/apps/api
ENV NODE_ENV=production

ARG API_SERVER_PORT=7531
EXPOSE ${API_SERVER_PORT} 9464

CMD ["sh", "-c", "pnpm -F @musubi/db exec drizzle-kit migrate && pnpm exec tsx src/index.ts"]
