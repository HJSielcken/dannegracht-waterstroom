# syntax=docker/dockerfile:1

# --- Build: static Vite bundle ---
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The front end talks to the /ais and /levels endpoints of server/ on the same origin.
ARG VITE_AIS_PROXY_URL=/ais
ENV VITE_AIS_PROXY_URL=${VITE_AIS_PROXY_URL}
RUN npm run build

# --- Runtime: one Node process serves the app, /levels and /ais ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY proxy/src ./proxy/src
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server/index.ts"]
