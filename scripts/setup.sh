#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/setup.sh
# Run once after cloning the repo.
# Sets up the folder, installs dependencies, configures launchd.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
USERNAME="$(whoami)"
NODE_PATH="$(which node)"

echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  Paisa — Setup                              │"
echo "└─────────────────────────────────────────────┘"
echo ""

# ── 1. Create data directory ──────────────────────────────────────────────────
DATA_DIR="$ROOT_DIR/data"
mkdir -p "$DATA_DIR"
echo "✓ Data directory: $DATA_DIR"

# ── 2. Create secrets.env if missing ─────────────────────────────────────────
SECRETS_FILE="$ROOT_DIR/secrets.env"
if [ ! -f "$SECRETS_FILE" ]; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$SECRETS_FILE" << EOF
PORT=3000
HOST=0.0.0.0
API_SECRET=$SECRET
DATA_DIR=$DATA_DIR
ICLOUD_BACKUP_DIR=$HOME/Library/Mobile Documents/com~apple~CloudDocs/ExpenseBackups
BACKUP_RETAIN_DAYS=90
LLM_FALLBACK_ENABLED=false
EOF
  echo "✓ Generated secrets.env with random API secret"
  echo ""
  echo "  !! IMPORTANT: Your API secret is:"
  echo "  $SECRET"
  echo "  You'll need this in the iOS app and PWA."
  echo ""
else
  echo "✓ secrets.env already exists"
fi

# ── 3. Install npm dependencies ───────────────────────────────────────────────
echo "→ Installing dependencies..."
cd "$ROOT_DIR" && npm install --silent
echo "✓ Dependencies installed"

# ── 4. Configure launchd plist ───────────────────────────────────────────────
PLIST_SRC="$ROOT_DIR/com.paisa.server.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.paisa.server.plist"

# Replace placeholder username and node path
sed \
  -e "s|REPLACE_WITH_YOUR_USERNAME|$USERNAME|g" \
  -e "s|/usr/local/bin/node|$NODE_PATH|g" \
  "$PLIST_SRC" > "$PLIST_DEST"

echo "✓ launchd plist installed → $PLIST_DEST"

# ── 5. Load launchd service ───────────────────────────────────────────────────
# Unload first in case it was previously loaded
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
echo "✓ Server service loaded (starts on every login)"

# ── 6. Wait and check server ─────────────────────────────────────────────────
echo ""
echo "→ Waiting for server to start..."
sleep 3

if curl -s http://localhost:3000/health | grep -q '"ok"'; then
  echo "✓ Server is running at http://localhost:3000"
else
  echo "⚠ Server may still be starting. Check logs:"
  echo "  tail -f $DATA_DIR/server.log"
fi

echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  Setup complete.                            │"
echo "│                                             │"
echo "│  Open http://localhost:3000 in your browser │"
echo "│  or install Tailscale for remote access.    │"
echo "└─────────────────────────────────────────────┘"
echo ""
