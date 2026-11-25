FROM node:24-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.32.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/mock-maker/package.json packages/mock-maker/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/contracts/deployments packages/contracts/deployments

RUN pnpm install --filter @payoff/shared --filter @payoff/mock-maker --filter @payoff/server --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/mock-maker packages/mock-maker
COPY packages/server packages/server

RUN pnpm --filter @payoff/shared build && pnpm --filter @payoff/mock-maker build && pnpm --filter @payoff/server build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.32.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/mock-maker/package.json packages/mock-maker/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/contracts/deployments packages/contracts/deployments

RUN pnpm install --filter @payoff/shared --filter @payoff/mock-maker --filter @payoff/server --prod --frozen-lockfile

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/mock-maker/dist packages/mock-maker/dist
COPY --from=builder /app/packages/server/dist packages/server/dist

EXPOSE 4000
CMD ["node", "packages/server/dist/index.js"]
