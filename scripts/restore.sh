#!/usr/bin/env bash
# scripts/restore.sh
# Restore a backup SQLite file to the active data directory.
# Usage: bash scripts/restore.sh /path/to/db-2026-2026-01-15.sqlite

set -euo pipefail

BACKUP_FILE="${1:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$ROOT_DIR/secrets.env"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: bash scripts/restore.sh /path/to/backup.sqlite"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: File not found: $BACKUP_FILE"
  exit 1
fi

# Read DATA_DIR from secrets.env
DATA_DIR=$(grep '^DATA_DIR=' "$SECRETS" | cut -d= -f2)

# Extract year from filename e.g. db-2026-2026-01-15.sqlite → 2026
YEAR=$(basename "$BACKUP_FILE" | grep -oE 'db-([0-9]{4})' | grep -oE '[0-9]{4}')
if [ -z "$YEAR" ]; then
  YEAR=$(date +%Y)
fi

DEST="$DATA_DIR/db-${YEAR}.sqlite"

echo "→ Stopping server..."
launchctl unload ~/Library/LaunchAgents/com.paisa.server.plist 2>/dev/null || true

echo "→ Copying $BACKUP_FILE → $DEST"
cp "$BACKUP_FILE" "$DEST"
chmod 644 "$DEST"

echo "→ Restarting server..."
launchctl load ~/Library/LaunchAgents/com.paisa.server.plist

echo "✓ Restored. Server restarting."
