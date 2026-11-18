FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY apps/media/package*.json ./apps/media/
WORKDIR /src/apps/media
RUN npm ci
COPY apps/media/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /src/apps/media/package.json ./
COPY --from=build /src/apps/media/node_modules ./node_modules
COPY --from=build /src/apps/media/dist ./dist
USER node
EXPOSE 3002
CMD ["node", "dist/worker.js"]
