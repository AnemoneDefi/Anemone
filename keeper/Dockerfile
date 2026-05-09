# Multi-stage build keeps the runtime image lean (no toolchain, no source).

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY anemone.idl.json ./
RUN yarn build

# Drop dev deps for the runtime image.
RUN yarn install --frozen-lockfile --production && yarn cache clean


FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV LOG_LEVEL=info

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/anemone.idl.json ./

USER node

CMD ["node", "dist/index.js"]
