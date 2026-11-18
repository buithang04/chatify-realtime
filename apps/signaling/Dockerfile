FROM node:22-alpine AS build
WORKDIR /src
COPY apps/signaling/package*.json ./apps/signaling/
WORKDIR /src/apps/signaling
RUN npm ci
COPY apps/signaling/ ./
RUN npm run build

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=production-deps /src/apps/signaling/package.json ./
COPY --from=production-deps /src/apps/signaling/node_modules ./node_modules
COPY --from=production-deps /src/apps/signaling/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
