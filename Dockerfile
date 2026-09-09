# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# @livekit/rtc-node is a Rust native binding that reads the SYSTEM trust store
# rather than Node's bundled one. The slim image ships without it, so joining a
# LiveKit room fails with "no native root CA certificates found" the moment a
# call is answered - long after the build looks healthy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run unprivileged; the node image already provides this user.
USER node

# Railway injects PORT; the server binds 0.0.0.0 so the edge can reach it.
EXPOSE 3000
CMD ["node", "dist/server.js"]
