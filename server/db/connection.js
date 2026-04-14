'use strict';

/**
 * db/connection.js
 *
 * Manages SQLite connections for yearly database files.
 * Each year has its own .sqlite file. Past years are opened read-only.
 * Multi-year queries open both files and merge results in JS.
 *
 * We use sql.js (pure JS SQLite) so no native compilation is needed —
 * works anywhere Node.js runs without extra build steps.
 */

const path    = require('path');
const fs      = require('fs');
const fse     = require('fs-extra');
const initSql = require('sql.js');

const config  = require('../../config.json');

// ─── In-memory registry of open databases ────────────────────────────────────
/** @type {Map<number, import('sql.js').Database>} */
const openDbs = new Map();

/** @type {import('sql.js').SqlJsStatic | null} */
let SQL = null;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Must be called once at server startup before any DB work.
 * Initialises sql.js and opens the active-year database.
 */
async function bootstrap() {
  SQL = await initSql();

  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error('DATA_DIR is not set in secrets.env');

  fse.ensureDirSync(dataDir);

  // Open active year (read-write)
  await openYear(config.active_year, false);

  console.log(`[db] Active year ${config.active_year} ready.`);
}

// ─── Open / close ─────────────────────────────────────────────────────────────

/**
 * Opens (or returns cached) database for a given year.
 *
 * @param {number}  year
 * @param {boolean} readOnly  - true for past years
 * @returns {import('sql.js').Database}
 */
async function openYear(year, readOnly = false) {
  if (openDbs.has(year)) return openDbs.get(year);

  const filePath = dbPath(year);
  let db;

  if (fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath);
    db = new SQL.Database(fileBuffer);
  } else {
    if (readOnly) throw new Error(`Database for year ${year} not found at ${filePath}`);
    db = new SQL.Database();
  }

  // WAL mode and foreign keys for every connection
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');

  if (!readOnly) {
    await runMigrations(db);
    seedCategories(db);
  }

  openDbs.set(year, db);

  // For read-write connections, persist to disk after every write
  if (!readOnly) {
    wrapWithAutoPersist(db, year);
  }

  return db;
}

/**
 * Returns the active (current year) read-write database.
 * @returns {import('sql.js').Database}
 */
function getActiveDb() {
  const db = openDbs.get(config.active_year);
  if (!db) throw new Error('Active database not initialised. Call bootstrap() first.');
  return db;
}

/**
 * Returns db for a specific year, opening read-only if needed.
 * @param {number} year
 * @returns {Promise<import('sql.js').Database>}
 */
async function getDbForYear(year) {
  if (openDbs.has(year)) return openDbs.get(year);
  const readOnly = year !== config.active_year;
  return openYear(year, readOnly);
}

// ─── Migrations ───────────────────────────────────────────────────────────────

async function runMigrations(db) {
  const migrationsDir = path.join(__dirname, 'migrations');

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();  // alphabetical = chronological given 001_, 002_ naming

  // Ensure schema_versions exists so we can check what's applied
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db.exec('SELECT version FROM schema_versions');
  const applied = new Set(
    appliedRows.length > 0 ? appliedRows[0].values.map(r => r[0]) : []
  );

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.run(sql);
    console.log(`[db] Migration ${file} applied.`);
  }
}

// ─── Seeding ──────────────────────────────────────────────────────────────────

function seedCategories(db) {
  const categories = require('./seed/categories.json');

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO categories
      (id, name, icon, color, is_income, sort_order)
    VALUES
      (:id, :name, :icon, :color, :is_income, :sort_order)
  `);

  for (const cat of categories) {
    stmt.run({
      ':id':         cat.id,
      ':name':       cat.name,
      ':icon':       cat.icon,
      ':color':      cat.color,
      ':is_income':  cat.is_income,
      ':sort_order': cat.sort_order,
    });
  }

  stmt.free();
}

// ─── Persist to disk ──────────────────────────────────────────────────────────

/**
 * Wraps db.run / db.exec to auto-save the SQLite file after every write.
 * sql.js is in-memory by default — we must explicitly flush to disk.
 */
function wrapWithAutoPersist(db, year) {
  const originalRun  = db.run.bind(db);
  const originalExec = db.exec.bind(db);

  db.run = (...args) => {
    const result = originalRun(...args);
    persistToDisk(db, year);
    return result;
  };

  db.exec = (...args) => {
    const result = originalExec(...args);
    persistToDisk(db, year);
    return result;
  };
}

function persistToDisk(db, year) {
  const filePath = dbPath(year);
  const data = db.export();
  fs.writeFileSync(filePath, Buffer.from(data));
}

// ─── Multi-year query helper ───────────────────────────────────────────────────

/**
 * Run the same query across multiple yearly databases and merge rows.
 * Used for cross-year reports (e.g. "last 3 months" in February).
 *
 * @param {number[]} years   - e.g. [2025, 2026]
 * @param {string}   sql     - query with optional :param bindings
 * @param {object}   params  - binding values
 * @returns {Promise<object[]>}
 */
async function queryAcrossYears(years, sql, params = {}) {
  const results = [];

  for (const year of years) {
    const db   = await getDbForYear(year);
    const rows = query(db, sql, params);
    results.push(...rows);
  }

  return results;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * Execute a SELECT and return rows as plain objects.
 * @param {import('sql.js').Database} db
 * @param {string} sql
 * @param {object} params
 * @returns {object[]}
 */
function query(db, sql, params = {}) {
  const stmt    = db.prepare(sql);
  const rows    = [];

  stmt.bind(params);
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();

  return rows;
}

/**
 * Execute a SELECT and return the first row or null.
 */
function queryOne(db, sql, params = {}) {
  const rows = query(db, sql, params);
  return rows[0] ?? null;
}

/**
 * Execute an INSERT / UPDATE / DELETE.
 * Returns the db instance for chaining.
 */
function run(db, sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
  return db;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function dbPath(year) {
  return path.join(process.env.DATA_DIR, `db-${year}.sqlite`);
}

/**
 * Manually flush a year's in-memory db to disk.
 * Called by the backup job before copying the file.
 */
function flushYear(year) {
  const db = openDbs.get(year);
  if (db) persistToDisk(db, year);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  bootstrap,
  getActiveDb,
  getDbForYear,
  queryAcrossYears,
  query,
  queryOne,
  run,
  flushYear,
  dbPath,
};
