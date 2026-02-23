#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Watch Tower — Database Backup
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: ./deploy/backup.sh [client-dir]
#
# Creates a timestamped pg_dump in ./backups/
# Add to cron for daily backups:
#   0 3 * * * /opt/watchtower/acme-corp/deploy/backup.sh /opt/watchtower/acme-corp
# ═══════════════════════════════════════════════════════════════════════════════

CLIENT_DIR="${1:-.}"
cd "$CLIENT_DIR"

BACKUP_DIR="./backups"
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
COMPOSE="docker compose -f docker-compose.prod.yml"

mkdir -p "$BACKUP_DIR"

echo "Backing up database..."
$COMPOSE exec -T postgres pg_dump -U watchtower watchtower | gzip > "$BACKUP_DIR/watchtower_${TIMESTAMP}.sql.gz"

# Keep only last 14 backups
ls -t "$BACKUP_DIR"/watchtower_*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm

SIZE=$(du -h "$BACKUP_DIR/watchtower_${TIMESTAMP}.sql.gz" | cut -f1)
echo "Backup complete: watchtower_${TIMESTAMP}.sql.gz ($SIZE)"
echo "Backups retained: $(ls "$BACKUP_DIR"/watchtower_*.sql.gz 2>/dev/null | wc -l)/14"
