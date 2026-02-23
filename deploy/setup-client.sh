#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Watch Tower — Client Instance Setup
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: ./deploy/setup-client.sh <clientname>
#
# What it does:
#   1. Creates /opt/watchtower/<clientname>/ directory
#   2. Clones the repo (or copies from local)
#   3. Copies .env.production.template → .env (for you to fill in)
#   4. Generates htpasswd file for dashboard auth
#   5. Runs DB migrations and seeds
#   6. Starts all services
#
# Prerequisites:
#   - Docker + Docker Compose installed
#   - Git installed
#   - htpasswd (apache2-utils) installed: apt install apache2-utils
# ═══════════════════════════════════════════════════════════════════════════════

CLIENT_NAME="${1:-}"
INSTALL_DIR="/opt/watchtower"
REPO_URL="${REPO_URL:-https://github.com/YOUR_ORG/watch-tower.git}"

# ── Validation ────────────────────────────────────────────────────────────────
if [ -z "$CLIENT_NAME" ]; then
    echo "Usage: $0 <clientname>"
    echo "Example: $0 acme-corp"
    exit 1
fi

# Sanitize client name (alphanumeric + hyphens only)
if ! echo "$CLIENT_NAME" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
    echo "Error: Client name must be lowercase alphanumeric with hyphens (e.g., 'acme-corp')"
    exit 1
fi

CLIENT_DIR="$INSTALL_DIR/$CLIENT_NAME"

if [ -d "$CLIENT_DIR" ]; then
    echo "Error: Directory $CLIENT_DIR already exists. Remove it first or choose a different name."
    exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo " Watch Tower — Setting up client: $CLIENT_NAME"
echo "═══════════════════════════════════════════════════════════════"

# ── Step 1: Create directory + clone ──────────────────────────────────────────
echo ""
echo "[1/6] Creating directory and cloning repo..."
mkdir -p "$CLIENT_DIR"

if [ -d ".git" ]; then
    echo "  → Local repo detected, copying files..."
    rsync -a --exclude=node_modules --exclude=.env --exclude='packages/*/dist' \
        . "$CLIENT_DIR/"
else
    echo "  → Cloning from $REPO_URL..."
    git clone "$REPO_URL" "$CLIENT_DIR"
fi

cd "$CLIENT_DIR"

# ── Step 2: Environment file ─────────────────────────────────────────────────
echo ""
echo "[2/6] Creating .env from template..."
if [ ! -f .env ]; then
    cp .env.production.template .env

    # Generate a random API key
    API_KEY=$(openssl rand -hex 32)
    sed -i "s/CHANGEME_RANDOM_API_KEY/$API_KEY/g" .env
    sed -i "s/CHANGEME_SAME_AS_API_KEY/$API_KEY/g" .env

    # Generate a random DB password
    DB_PASS=$(openssl rand -hex 16)
    sed -i "s/CHANGEME_STRONG_DB_PASSWORD/$DB_PASS/g" .env

    echo "  → .env created with random API_KEY and DB password"
    echo "  → IMPORTANT: Edit .env to fill in remaining CHANGEME values:"
    echo "    - API keys (OpenAI, Anthropic, Google AI)"
    echo "    - Social platform tokens (Telegram, Facebook, LinkedIn)"
    echo "    - Domain name"
    echo "    - R2 credentials (if using image generation)"
else
    echo "  → .env already exists, skipping"
fi

# ── Step 3: Basic auth ───────────────────────────────────────────────────────
echo ""
echo "[3/6] Setting up dashboard authentication..."
mkdir -p deploy/nginx

if [ ! -f deploy/nginx/.htpasswd ]; then
    read -p "  Dashboard username [admin]: " AUTH_USER
    AUTH_USER="${AUTH_USER:-admin}"

    read -sp "  Dashboard password: " AUTH_PASS
    echo ""

    if [ -z "$AUTH_PASS" ]; then
        AUTH_PASS=$(openssl rand -base64 12)
        echo "  → Generated random password: $AUTH_PASS"
    fi

    htpasswd -cb deploy/nginx/.htpasswd "$AUTH_USER" "$AUTH_PASS"
    echo "  → Credentials saved to deploy/nginx/.htpasswd"
else
    echo "  → .htpasswd already exists, skipping"
fi

# ── Step 4: Build containers ─────────────────────────────────────────────────
echo ""
echo "[4/6] Building Docker images (this takes a few minutes)..."
docker compose -f docker-compose.prod.yml build

# ── Step 5: Start infrastructure + run migrations ────────────────────────────
echo ""
echo "[5/6] Starting infrastructure and running migrations..."

# Start postgres + redis first
docker compose -f docker-compose.prod.yml up -d postgres redis
echo "  → Waiting for PostgreSQL to be ready..."
sleep 5

# Run migrations via a temporary API container
echo "  → Running database migrations..."
docker compose -f docker-compose.prod.yml run --rm api \
    sh -c "cd /app && node packages/db/dist/migrate.js" 2>/dev/null || \
    echo "  → Note: Auto-migration skipped. Run 'npm run db:push' manually if needed."

# Seed app_config defaults
echo "  → Seeding default configuration..."
docker compose -f docker-compose.prod.yml run --rm api \
    sh -c "cd /app && node packages/db/dist/seed-runner.mjs" 2>/dev/null || \
    echo "  → Note: Auto-seed skipped. Run 'npm run db:seed' manually if needed."

# ── Step 6: Start all services ────────────────────────────────────────────────
echo ""
echo "[6/6] Starting all services..."
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Setup complete for: $CLIENT_NAME"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo " Directory:  $CLIENT_DIR"
echo " Dashboard:  http://$(hostname -I | awk '{print $1}' 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo ""
echo " Next steps:"
echo "   1. Edit $CLIENT_DIR/.env — fill in CHANGEME values"
echo "   2. Rebuild after .env changes: docker compose -f docker-compose.prod.yml up -d --build"
echo "   3. Set up DNS: point your domain to this server's IP"
echo "   4. Set up SSL: uncomment certbot in docker-compose.prod.yml"
echo "   5. Add RSS sources via the dashboard"
echo "   6. Configure scoring rules per sector"
echo "   7. Test the pipeline: articles should start flowing within minutes"
echo ""
echo " Useful commands:"
echo "   cd $CLIENT_DIR"
echo "   docker compose -f docker-compose.prod.yml logs -f worker    # Watch pipeline"
echo "   docker compose -f docker-compose.prod.yml logs -f api       # Watch API"
echo "   docker compose -f docker-compose.prod.yml ps                # Service status"
echo "   docker compose -f docker-compose.prod.yml restart worker    # Restart worker"
echo ""
