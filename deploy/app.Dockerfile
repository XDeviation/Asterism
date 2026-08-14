FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/app/package.json apps/app/tsconfig.json ./apps/app/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html ./apps/web/
RUN npm ci

COPY packages/shared/src ./packages/shared/src
COPY apps/app/src ./apps/app/src
COPY apps/web/src ./apps/web/src
RUN npm run build --workspace @asterism/shared \
    && npm run build --workspace @asterism/web \
    && npm run build --workspace @asterism/app \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/app/package.json ./apps/app/package.json
COPY --from=build /app/apps/app/dist ./apps/app/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "apps/app/dist/index.js"]

