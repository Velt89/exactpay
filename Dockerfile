# ExactPay web app. Build:  docker build -t exactpay .
# Run:    docker run -p 3000:3000 --env-file web/.env.local exactpay
# The NEXT_PUBLIC_* values below are public contract addresses (no secrets); the only
# secret, RELAYER_PRIVATE_KEY, is read at runtime from the env file and never baked in.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
COPY packages/aevum/package.json packages/aevum/package.json
COPY examples/package.json examples/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_NETWORKS=aevum
ARG NEXT_PUBLIC_INVOICEPAY_AEVUM=0xc6C7aa266eE2Bad2f1d12D09Ebef706bAf934702
ARG NEXT_PUBLIC_DIRECTORY_AEVUM=0x5c17A736dB5DE648d5E2901038FCDd75Ba5121f2
ARG NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM=3802447
ENV NEXT_PUBLIC_NETWORKS=$NEXT_PUBLIC_NETWORKS \
    NEXT_PUBLIC_INVOICEPAY_AEVUM=$NEXT_PUBLIC_INVOICEPAY_AEVUM \
    NEXT_PUBLIC_DIRECTORY_AEVUM=$NEXT_PUBLIC_DIRECTORY_AEVUM \
    NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM=$NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM
RUN pnpm --filter web build

FROM node:22-alpine AS run
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/web ./web
EXPOSE 3000
WORKDIR /repo/web
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000"]
