#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Watch Tower — Deploy Update to ALL Client Instances
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: ./deploy/deploy-all.sh
#
# Iterates over all directories in /opt/watchtower/ and runs deploy.sh on each.
# Skips directories without docker-compose.prod.yml.
# ═══════════════════════════════════════════════════════════════════════════════

INSTALL_DIR="${INSTALL_DIR:-/opt/watchtower}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "═══════════════════════════════════════════════════════════════"
echo " Watch Tower — Deploying to all instances"
echo " Base directory: $INSTALL_DIR"
echo "═══════════════════════════════════════════════════════════════"

TOTAL=0
SUCCESS=0
FAILED=0

for CLIENT_DIR in "$INSTALL_DIR"/*/; do
    CLIENT_NAME=$(basename "$CLIENT_DIR")

    # Skip if no docker-compose.prod.yml
    if [ ! -f "$CLIENT_DIR/docker-compose.prod.yml" ]; then
        echo "  → Skipping $CLIENT_NAME (no docker-compose.prod.yml)"
        continue
    fi

    TOTAL=$((TOTAL + 1))
    echo ""
    echo "───────────────────────────────────────────────────────────"
    echo " Deploying: $CLIENT_NAME"
    echo "───────────────────────────────────────────────────────────"

    if bash "$CLIENT_DIR/deploy/deploy.sh" "$CLIENT_DIR"; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAILED=$((FAILED + 1))
        echo "  → FAILED: $CLIENT_NAME — check logs manually"
    fi
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Deploy-all complete: $SUCCESS/$TOTAL succeeded, $FAILED failed"
echo "═══════════════════════════════════════════════════════════════"
