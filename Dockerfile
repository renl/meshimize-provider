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

# Install git (needed for acquire-docs.sh at runtime), Python 3 + pip
RUN apt-get update && \
    apt-get install -y git python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install ChromaDB and supervisord via pip
RUN pip3 install --break-system-packages chromadb==1.5.2 supervisor==4.3.0

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/ ./dist/
COPY scripts/ ./scripts/
COPY config/ ./config/

# ChromaDB data directory (Fly.io volume mount point)
RUN mkdir -p /data/chromadb

# docs-source directory (Fly.io volume mount point)
RUN mkdir -p /data/docs-source

# Create supervisord configuration
RUN cat > /etc/supervisord.conf << 'SUPERVISORD_EOF'
[supervisord]
nodaemon=true
user=root
logfile=/dev/null
logfile_maxbytes=0

[program:chromadb]
command=chroma run --path %(ENV_CHROMADB_PERSIST_DIR)s --host 127.0.0.1 --port 8000
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:node]
command=node dist/index.js
directory=/app
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SUPERVISORD_EOF

ENV NODE_ENV=production
ENV CHROMADB_PERSIST_DIR=/data/chromadb

EXPOSE 8080

CMD ["supervisord", "-c", "/etc/supervisord.conf", "-n"]
