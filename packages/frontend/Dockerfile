# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
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

COPY packages/shared packages/shared
COPY packages/frontend packages/frontend

# Vite bakes env vars at build time
ARG VITE_API_URL=http://localhost:3001
ARG VITE_API_KEY=local-dev-key
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_KEY=$VITE_API_KEY

RUN npm --workspace @watch-tower/shared run build && \
    npm --workspace @watch-tower/frontend run build

# ── Stage 2: Serve static files ───────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html

# SPA fallback: all routes serve index.html
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
