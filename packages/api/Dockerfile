# ── Stage 1: Install dependencies ──────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy root manifests
COPY package.json package-lock.json ./

# Copy ALL workspace package.json files (npm workspaces needs them)
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/embeddings/package.json packages/embeddings/package.json
COPY packages/translation/package.json packages/translation/package.json
COPY packages/social/package.json packages/social/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/frontend/package.json packages/frontend/package.json

RUN npm ci --ignore-scripts

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM deps AS builder

# Copy source for API and its workspace dependencies
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/api packages/api

# Build in dependency order (turbo not available, manual order)
RUN npm --workspace @watch-tower/shared run build && \
    npm --workspace @watch-tower/db run build && \
    npm --workspace @watch-tower/api run build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy root manifests + lockfile
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/api/package.json packages/api/package.json

# Install production deps only
RUN npm ci --omit=dev --ignore-scripts

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/api/dist packages/api/dist

# Copy package.json into dist dirs (for module resolution)
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/db/package.json packages/db/package.json
COPY --from=builder /app/packages/api/package.json packages/api/package.json

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "packages/api/dist/index.js"]
