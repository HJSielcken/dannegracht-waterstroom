# syntax=docker/dockerfile:1

# --- Base: Node with pnpm (keep in sync with packageManager in package.json) ---
FROM node:26-alpine AS base
RUN npm install -g pnpm@12.6.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# --- Build: static Vite bundle ---
FROM base AS build
RUN pnpm install --frozen-lockfile

COPY . .

# The front end talks to the /ais and /levels endpoints of server/ on the same origin.
ARG VITE_AIS_PROXY_URL=/ais
ENV VITE_AIS_PROXY_URL=${VITE_AIS_PROXY_URL}
RUN pnpm run build

# --- Production dependencies only ---
FROM base AS deps
RUN pnpm install --prod --frozen-lockfile

# --- Runtime: one Node process serves the app, /levels and /ais ---
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server/index.ts"]
