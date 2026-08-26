# CodeForge Server/CLI Docker Image
# Multi-stage build - no native compilation needed in runner (node:sqlite is builtin)

# ============================================
# Stage 1: Builder
# ============================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/forge-zero/package.json ./packages/forge-zero/
COPY packages/model-registry/package.json ./packages/model-registry/
COPY packages/providers/package.json ./packages/providers/
COPY packages/router/package.json ./packages/router/
COPY packages/agent/package.json ./packages/agent/
COPY packages/director/package.json ./packages/director/
COPY packages/tools/package.json ./packages/tools/
COPY packages/sessions/package.json ./packages/sessions/
COPY packages/context/package.json ./packages/context/
COPY packages/git/package.json ./packages/git/
COPY packages/permissions/package.json ./packages/permissions/
COPY packages/sandbox/package.json ./packages/sandbox/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/server/package.json ./packages/server/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/cli/package.json ./packages/cli/
COPY packages/lsp/package.json ./packages/lsp/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY packages/gems/package.json ./packages/gems/
COPY packages/plugins/package.json ./packages/plugins/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/

# Copy tsconfig files
COPY tsconfig.json tsconfig.base.json ./

# Install dependencies
RUN npm ci

# Copy source code for required packages only
COPY packages ./packages

# Build all packages (npm handles dependency order)
RUN npm run build --workspaces --if-present 2>&1 || true

# ============================================
# Stage 2: Runner (minimal image)
# ============================================
FROM node:22-alpine AS runner

# Create non-root user for security
RUN addgroup --system --gid 1001 codeforge && \
    adduser --system --uid 1001 --ingroup codeforge codeforge

WORKDIR /app

# Copy production node_modules and built packages
COPY --from=builder --chown=codeforge:codeforge /app/node_modules ./node_modules
COPY --from=builder --chown=codeforge:codeforge /app/packages ./packages
COPY --from=builder --chown=codeforge:codeforge /app/package.json ./package.json

# Create data directory for SQLite persistence
RUN mkdir -p /data && chown codeforge:codeforge /data

# Switch to non-root user
USER codeforge

# Environment variables for persistence
ENV CODEFORGE_DB_PATH=/data/codeforge.db
ENV NODE_ENV=production

# Default command - run the server
CMD ["node", "packages/server/dist/index.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Expose server port
EXPOSE 3000

# Volume for persistent data
VOLUME ["/data"]
