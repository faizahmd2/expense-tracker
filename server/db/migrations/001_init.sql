-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001 — Initial Schema
-- All tables for one year's expense-tracker database.
-- Runs once per yearly db file on first boot.
-- ─────────────────────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Schema version tracking ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_versions (
  version     INTEGER PRIMARY KEY,
  description TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Categories ───────────────────────────────────────────────────────────────
-- User-defined. Seeded with defaults, fully editable.
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  icon       TEXT NOT NULL DEFAULT '💰',
  color      TEXT NOT NULL DEFAULT '#6B7280',
  is_income  INTEGER NOT NULL DEFAULT 0,   -- 1 = income category
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Accounts ─────────────────────────────────────────────────────────────────
-- Seeded from config.json on startup. User can add/edit.
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  bank         TEXT,
  type         TEXT NOT NULL CHECK(type IN ('savings','current','credit','cash','wallet')),
  currency     TEXT NOT NULL DEFAULT 'INR',
  is_active    INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Merchants ────────────────────────────────────────────────────────────────
-- Auto-populated by parser. Maps raw merchant names → category.
-- This is the "learning" table — gets smarter over time.
CREATE TABLE IF NOT EXISTS merchants (
  id              TEXT PRIMARY KEY,
  raw_name        TEXT NOT NULL,              -- exactly as seen in notification
  normalized_name TEXT NOT NULL,              -- cleaned: "SWIGGY ORDER" → "Swiggy"
  category_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,  -- 0.0–1.0, lower = needs review
  source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK(source IN ('manual','rule','llm','aa')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(raw_name)
);

-- ─── Transactions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  category_id      TEXT REFERENCES categories(id) ON DELETE SET NULL,
  merchant_id      TEXT REFERENCES merchants(id) ON DELETE SET NULL,

  -- Core financials
  amount           REAL NOT NULL CHECK(amount > 0),
  type             TEXT NOT NULL CHECK(type IN ('debit','credit','transfer')),
  currency         TEXT NOT NULL DEFAULT 'INR',

  -- Transfer linking (both sides reference each other)
  transfer_pair_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,

  -- Metadata
  merchant_raw     TEXT,                    -- raw name from notification / statement
  note             TEXT,                    -- user's own note
  reference_number TEXT,                    -- bank ref / UTR number
  tags             TEXT DEFAULT '[]',       -- JSON array of strings

  -- Dates
  transacted_at    TEXT NOT NULL,           -- actual transaction time (from notification/AA)
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),

  -- Source tracking
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK(source IN ('notification','aa','import','manual')),
  raw_notification TEXT,                    -- original notification text, kept for debugging

  -- Status flags
  is_verified      INTEGER NOT NULL DEFAULT 0,   -- 1 = user confirmed/reviewed
  is_excluded      INTEGER NOT NULL DEFAULT 0,   -- 1 = exclude from totals (e.g. reimbursable)
  needs_review     INTEGER NOT NULL DEFAULT 0    -- 1 = parser was uncertain
);

-- ─── Sync Queue (phone-side only, present in queue.sqlite) ────────────────────
-- On Mac db this table exists but stays empty.
-- On phone queue.sqlite this tracks every offline mutation.
CREATE TABLE IF NOT EXISTS sync_queue (
  op_id        TEXT PRIMARY KEY,
  entity       TEXT NOT NULL CHECK(entity IN ('transaction','category','merchant','account')),
  entity_id    TEXT NOT NULL,
  op_type      TEXT NOT NULL CHECK(op_type IN ('INSERT','UPDATE','DELETE')),
  payload      TEXT NOT NULL,   -- JSON snapshot of the full row at time of operation
  changed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at    TEXT            -- NULL until successfully synced
);

-- ─── Sync State ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('last_synced_at', '1970-01-01T00:00:00.000Z');

-- ─── Conflicts ────────────────────────────────────────────────────────────────
-- Only populated when a delete-vs-edit conflict is detected during sync.
CREATE TABLE IF NOT EXISTS conflicts (
  id           TEXT PRIMARY KEY,
  entity       TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  mac_payload  TEXT NOT NULL,    -- JSON: what Mac has
  phone_payload TEXT NOT NULL,   -- JSON: what phone sent
  detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT,
  resolution   TEXT              -- 'kept_mac' | 'kept_phone' | 'merged'
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_account    ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category   ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_transacted ON transactions(transacted_at);
CREATE INDEX IF NOT EXISTS idx_transactions_type       ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_review     ON transactions(needs_review) WHERE needs_review = 1;
CREATE INDEX IF NOT EXISTS idx_merchants_raw           ON merchants(raw_name);
CREATE INDEX IF NOT EXISTS idx_sync_queue_unsynced     ON sync_queue(synced_at) WHERE synced_at IS NULL;

INSERT OR IGNORE INTO schema_versions (version, description) VALUES (1, 'Initial schema');
