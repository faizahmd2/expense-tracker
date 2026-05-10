'use strict';

/**
 * server/index.js
 *
 * Entry point. Boots the database, registers all routes, starts Express.
 * Designed to be managed by launchd on macOS — crash = auto-restart.
 */

require('dotenv').config({ path: '/Users/faiz/Desktop/playground/working-repos/expense-tracker/secrets.env' });


const express = require('express');
const path    = require('path');

const { bootstrap }      = require('./db/connection');
const { requireAuth }    = require('./middleware/auth');
const { errorHandler }   = require('./middleware/errorHandler');
const { seedFromConfig } = require('./routes/accounts');
const { scheduleBackup } = require('./jobs/backup');
const { scheduleNewYear } = require('./jobs/newYear');

const transactionsRouter = require('./routes/transactions');
const categoriesRouter   = require('./routes/categories');
const { router: accountsRouter } = require('./routes/accounts');
const syncRouter         = require('./routes/sync');
const merchantsRouter    = require('./routes/merchants');
const importRouter       = require('./routes/import');

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function start() {
  // 1. Initialise database (migrations + seeds)
  await bootstrap();

  // 2. Seed accounts from config
  seedFromConfig();

  // 3. Start scheduled jobs
  scheduleBackup();
  scheduleNewYear();

  // 4. Build Express app
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ── Health check (no auth required — used by iOS app to test connectivity) ──
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // ── Static PWA ────────────────────────────────────────────────────────────
  const pwaDir = path.join(__dirname, '../pwa');
  app.use(express.static(pwaDir));

  // ── API routes (all require auth) ─────────────────────────────────────────
  app.use('/api', requireAuth);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/categories',   categoriesRouter);
  app.use('/api/accounts',     accountsRouter);
  app.use('/api/sync',         syncRouter);
  app.use('/api/merchants',    merchantsRouter);
  app.use('/api/import',       importRouter);

  // ── SPA fallback — serve index.html for all non-API routes ────────────────
  app.get(/.*$/, (req, res) => {
    res.sendFile(path.join(pwaDir, 'index.html'));
  });

  // ── Central error handler ─────────────────────────────────────────────────
  app.use(errorHandler);

  // 5. Listen
  const PORT = process.env.PORT ?? 3100;
  const HOST = process.env.HOST ?? '0.0.0.0';

  app.listen(PORT, HOST, () => {
    console.log(`[server] Running at http://${HOST}:${PORT}`);
    console.log(`[server] Open http://localhost:${PORT} in your browser.`);
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down gracefully.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[server] SIGINT received — shutting down.');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  process.exit(1);  // launchd will restart us
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
  process.exit(1);
});

start();
