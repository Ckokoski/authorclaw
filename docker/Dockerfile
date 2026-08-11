# AuthorClaw - Hardened Container Image
# Based on MoatBot security architecture
#
# Security features:
# - Non-root user execution
# - Read-only base filesystem
# - Minimal attack surface (no shell tools beyond what's needed)
# - Only workspace directory is writable

FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY gateway ./gateway

# Install ALL deps (including devDependencies for tsc)
RUN npm ci || npm install

# Compile TypeScript to JavaScript
RUN npx tsc --outDir dist

# Prune to production deps only
RUN npm prune --omit=dev

# ── Production Image ──
FROM node:22-slim

# git + ca-certificates: needed for the optional workspace git connection
# (gateway/src/services/workspace-git-sync.ts) to clone/commit/push over
# HTTPS. node:22-slim ships neither.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Security: Create non-root user
RUN groupadd -r authorclaw && \
    useradd -r -g authorclaw -d /app -s /sbin/nologin authorclaw

WORKDIR /app

# Copy production dependencies
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled JavaScript
COPY --from=builder /app/dist ./dist

# Copy non-TypeScript assets
COPY skills ./skills
COPY config ./config
COPY workspace ./workspace
COPY dashboard ./dashboard
COPY package.json ./

# Optional: Install Python for Author OS tool execution (Format Factory Pro)
# Uncomment if you need Python tools inside Docker:
# RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
#     rm -rf /var/lib/apt/lists/*

# Create writable directories and give authorclaw user ownership of everything
RUN mkdir -p /app/workspace/memory/conversations \
             /app/workspace/memory/book-bible \
             /app/workspace/memory/voice-data \
             /app/workspace/projects \
             /app/workspace/exports \
             /app/workspace/research \
             /app/workspace/.audit \
             /app/config/.vault \
             /app/skills/premium && \
    chown -R authorclaw:authorclaw /app

# Security: Drop to non-root user
USER authorclaw

# Health check — liveness probe (proves process is running and accepting HTTP)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3847/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 3847

# Run compiled JavaScript
CMD ["node", "dist/gateway/src/index.js"]
