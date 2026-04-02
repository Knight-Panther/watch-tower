# ── Stage 1: Install dependencies ──────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Native build tools for sharp + @napi-rs/canvas
RUN apk add --no-cache python3 make g++ pkgconfig pixman-dev cairo-dev pango-dev jpeg-dev giflib-dev

# Copy root manifests
COPY package.json package-lock.json tsconfig.base.json ./

# Copy ALL workspace package.json files (npm workspaces needs them)
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/rss/package.json packages/rss/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/embeddings/package.json packages/embeddings/package.json
COPY packages/translation/package.json packages/translation/package.json
COPY packages/social/package.json packages/social/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/frontend/package.json packages/frontend/package.json

RUN npm ci

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM deps AS builder

# Copy source for worker and all its workspace dependencies
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/rss packages/rss
COPY packages/llm packages/llm
COPY packages/embeddings packages/embeddings
COPY packages/translation packages/translation
COPY packages/social packages/social
COPY packages/worker packages/worker

# Build in dependency order
RUN npm --workspace @watch-tower/shared run build && \
    npm --workspace @watch-tower/db run build && \
    npm --workspace @watch-tower/rss run build && \
    npm --workspace @watch-tower/llm run build && \
    npm --workspace @watch-tower/embeddings run build && \
    npm --workspace @watch-tower/translation run build && \
    npm --workspace @watch-tower/social run build && \
    npm --workspace @watch-tower/worker run build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Runtime deps for canvas/sharp + proper NotoSansGeorgian font
RUN apk add --no-cache pixman cairo pango jpeg giflib font-noto-georgian

WORKDIR /app

# Copy root manifests
COPY package.json package-lock.json ./

# Copy node_modules from deps stage (already compiled with native build tools)
# Root hoisted modules
COPY --from=deps /app/node_modules ./node_modules
# Workspace-local modules that npm didn't hoist (e.g. openai version conflict)
COPY --from=deps /app/packages/worker/node_modules ./packages/worker/node_modules
COPY --from=deps /app/packages/llm/node_modules ./packages/llm/node_modules
COPY --from=deps /app/packages/embeddings/node_modules ./packages/embeddings/node_modules
COPY --from=deps /app/packages/translation/node_modules ./packages/translation/node_modules
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/rss/package.json packages/rss/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/embeddings/package.json packages/embeddings/package.json
COPY packages/translation/package.json packages/translation/package.json
COPY packages/social/package.json packages/social/package.json
COPY packages/worker/package.json packages/worker/package.json

# Copy built artifacts from all workspace packages
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/rss/dist packages/rss/dist
COPY --from=builder /app/packages/llm/dist packages/llm/dist
COPY --from=builder /app/packages/embeddings/dist packages/embeddings/dist
COPY --from=builder /app/packages/translation/dist packages/translation/dist
COPY --from=builder /app/packages/social/dist packages/social/dist
COPY --from=builder /app/packages/worker/dist packages/worker/dist
COPY packages/worker/assets packages/worker/assets

# Use the proper font from the Alpine package (committed file is a placeholder)
RUN cp /usr/share/fonts/noto/NotoSansGeorgian-Bold.ttf packages/worker/assets/fonts/NotoSansGeorgian-Bold.ttf

ENV NODE_ENV=production

CMD ["node", "packages/worker/dist/index.js"]
