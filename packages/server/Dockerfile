FROM node:24-trixie-slim AS builder
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

FROM node:24-trixie-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV THETADATA_PYTHON_BIN=/opt/thetadata-venv/bin/python3

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/thetadata-venv \
  && /opt/thetadata-venv/bin/pip install --no-cache-dir --only-binary=:all: thetadata==1.0.18 python-dotenv==1.2.4 \
  && /opt/thetadata-venv/bin/python3 -c "from thetadata import ThetaClient; print('thetadata import ok')"

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
COPY scripts/fetch-thetadata-iv.py scripts/fetch-thetadata-iv.py

EXPOSE 4000
CMD ["node", "packages/server/dist/index.js"]
