FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/bot/package.json apps/bot/tsconfig.json ./apps/bot/
RUN npm ci

COPY packages/shared/src ./packages/shared/src
COPY apps/bot/src ./apps/bot/src
RUN npm run build --workspace @asterism/shared \
    && npm run build --workspace @asterism/bot \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/bot/package.json ./apps/bot/package.json
COPY --from=build /app/apps/bot/dist ./apps/bot/dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
CMD ["node", "apps/bot/dist/index.js"]

