# ─── Build Stage ───
FROM node:22-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Production Stage ───
FROM node:22-slim

WORKDIR /app

# Install git (needed for acquire-docs.sh at runtime)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/ ./dist/
COPY scripts/ ./scripts/
COPY config/ ./config/

# ChromaDB data directory (Fly.io volume mount point)
RUN mkdir -p /data/chromadb

# docs-source directory (Fly.io volume mount point)
RUN mkdir -p /data/docs-source

ENV NODE_ENV=production
ENV CHROMADB_PERSIST_DIR=/data/chromadb

EXPOSE 8080

CMD ["node", "dist/index.js"]
