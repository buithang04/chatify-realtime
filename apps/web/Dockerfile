FROM node:22-alpine AS build

WORKDIR /app
COPY apps/web/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY apps/web/ ./
ARG VITE_API_URL=http://localhost:8080
ARG VITE_SIGNALING_URL=http://localhost:3001
ARG VITE_MEDIA_URL=http://localhost:3002
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SIGNALING_URL=$VITE_SIGNALING_URL
ENV VITE_MEDIA_URL=$VITE_MEDIA_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
