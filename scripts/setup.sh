#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/setup.sh
# Run once after cloning the repo.
# Prepares environment, installs dependencies.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
USERNAME="$(whoami)"

echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  Paisa — Setup                              │"
echo "└─────────────────────────────────────────────┘"
echo ""

# ── 0. Ensure NVM + Node is available ─────────────────────────────────────────
export NVM_DIR="$HOME/.nvm"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
else
  echo "❌ NVM not found. Please install NVM first."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node not found via NVM. Installing latest LTS..."
  nvm install --lts
fi

nvm use node > /dev/null

echo "✓ Using Node: $(node -v)"

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

  echo "✓ Generated secrets.env"
  echo ""
  echo "  🔐 API SECRET:"
  echo "  $SECRET"
  echo ""
else
  echo "✓ secrets.env already exists"
fi

# ── 3. Install npm dependencies ───────────────────────────────────────────────
echo "→ Installing dependencies..."
cd "$ROOT_DIR"
npm install --silent
echo "✓ Dependencies installed"

# ── 4. Done ──────────────────────────────────────────────────────────────────
echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  Setup complete                            │"
echo "│                                            │"
echo "│  Start server using:                       │"
echo "│  ./scripts/start.sh                        │"
echo "└─────────────────────────────────────────────┘"
echo ""