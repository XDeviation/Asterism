FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/room/package.json apps/room/tsconfig.json ./apps/room/
RUN npm ci

COPY apps/room/src ./apps/room/src
RUN npm run build --workspace @asterism/room \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/room/package.json ./apps/room/package.json
COPY --from=build /app/apps/room/dist ./apps/room/dist

USER node
EXPOSE 3002
CMD ["node", "apps/room/dist/index.js"]
