# syntax=docker/dockerfile:1

# --- Build: static Vite bundle ---
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time setting: Vite bakes it into the bundle. Empty disables live AIS and water levels.
ARG VITE_AIS_PROXY_URL=
ENV VITE_AIS_PROXY_URL=${VITE_AIS_PROXY_URL}
RUN npm run build

# --- Runtime: serve dist/ with nginx ---
FROM nginx:1.29-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
