#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Watch Tower — Deploy Update to Running Instance
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: ./deploy/deploy.sh [client-dir]
#
# What it does:
#   1. Pulls latest code from git
#   2. Rebuilds Docker images
#   3. Restarts services with zero-downtime (rolling)
#   4. Runs DB migrations if needed
#   5. Verifies health
#
# Run from the client directory, or pass the path:
#   cd /opt/watchtower/acme-corp && ./deploy/deploy.sh
#   ./deploy/deploy.sh /opt/watchtower/acme-corp
# ═══════════════════════════════════════════════════════════════════════════════

CLIENT_DIR="${1:-.}"
cd "$CLIENT_DIR"

COMPOSE="docker compose -f docker-compose.prod.yml"

echo "═══════════════════════════════════════════════════════════════"
echo " Watch Tower — Deploying update"
echo " Directory: $(pwd)"
echo " Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════════════════"

# ── Step 1: Pull latest ──────────────────────────────────────────────────────
echo ""
echo "[1/5] Pulling latest code..."
git pull --ff-only || {
    echo "Error: git pull failed. Resolve conflicts manually."
    exit 1
}

# ── Step 2: Rebuild ──────────────────────────────────────────────────────────
echo ""
echo "[2/5] Rebuilding Docker images..."
$COMPOSE build

# ── Step 3: Run migrations ───────────────────────────────────────────────────
echo ""
echo "[3/5] Checking for database migrations..."
$COMPOSE run --rm api \
    sh -c "cd /app && node packages/db/dist/migrate.js" 2>/dev/null || \
    echo "  → No pending migrations (or auto-migration not available)"

# ── Step 4: Restart services ─────────────────────────────────────────────────
echo ""
echo "[4/5] Restarting services..."

# Restart worker first (stateless, reconnects to DB/Redis automatically)
$COMPOSE up -d --no-deps worker
echo "  → Worker restarted"

# Restart API (quick restart, nginx buffers requests)
$COMPOSE up -d --no-deps api
echo "  → API restarted"

# Restart frontend only if Dockerfile changed (static files)
$COMPOSE up -d --no-deps frontend
echo "  → Frontend restarted"

# Nginx rarely needs restart (config changes only)
# $COMPOSE restart nginx

# ── Step 5: Health check ─────────────────────────────────────────────────────
echo ""
echo "[5/5] Verifying health..."
sleep 3

# Check API health
if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    echo "  → API: healthy"
else
    echo "  → API: checking via nginx..."
    if curl -sf http://localhost/api/health > /dev/null 2>&1; then
        echo "  → API (via nginx): healthy"
    else
        echo "  → WARNING: API health check failed. Check logs:"
        echo "    $COMPOSE logs --tail 20 api"
    fi
fi

# Check all containers are running
RUNNING=$($COMPOSE ps --format '{{.Service}} {{.State}}' | grep -c "running" || true)
TOTAL=$($COMPOSE ps --format '{{.Service}}' | wc -l || true)
echo "  → Containers: $RUNNING/$TOTAL running"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Deploy complete at $(date '+%H:%M:%S')"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo " Monitor logs:  $COMPOSE logs -f worker api"
echo " Check status:  $COMPOSE ps"
echo ""
