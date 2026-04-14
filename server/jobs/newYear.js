'use strict';

/**
 * jobs/newYear.js
 *
 * Runs automatically on Jan 1st via node-cron (and can be run manually).
 * 1. Seals the current year's DB as read-only.
 * 2. Creates a fresh DB for the new year with schema + seeds.
 * 3. Updates config.json active_year.
 * 4. Triggers a backup of the sealed year.
 */

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const { bootstrap, flushYear, dbPath } = require('../db/connection');
const { runBackup } = require('./backup');
const config = require('../../config.json');

const CONFIG_PATH = path.join(__dirname, '../../config.json');

// ─── Schedule ─────────────────────────────────────────────────────────────────

function scheduleNewYear() {
  const schedule = config.backup?.new_year_cron ?? '0 0 1 1 *';  // Jan 1st midnight

  cron.schedule(schedule, async () => {
    console.log('[new-year] New year job triggered.');
    try {
      await runNewYear();
    } catch (err) {
      console.error('[new-year] Failed:', err.message);
    }
  });

  console.log(`[new-year] Scheduled with cron: "${schedule}"`);
}

// ─── Core logic ───────────────────────────────────────────────────────────────

async function runNewYear() {
  const currentYear = config.active_year;
  const nextYear    = currentYear + 1;

  console.log(`[new-year] Sealing ${currentYear}, creating ${nextYear}...`);

  // 1. Flush current year to disk
  flushYear(currentYear);

  // 2. Backup current year before sealing
  await runBackup();

  // 3. Seal current year file as read-only
  const currentFile = dbPath(currentYear);
  if (fs.existsSync(currentFile)) {
    fs.chmodSync(currentFile, 0o444);
    console.log(`[new-year] Sealed ${currentFile} (read-only).`);
  }

  // 4. Update config.json
  const updatedConfig = { ...config, active_year: nextYear };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2), 'utf8');
  console.log(`[new-year] config.json updated → active_year: ${nextYear}`);

  // 5. Bootstrap new year DB (creates file, runs migrations, seeds categories)
  // We require config fresh after writing it
  delete require.cache[require.resolve('../../config.json')];
  await bootstrap();

  console.log(`[new-year] ✅ Ready for ${nextYear}.`);
}

module.exports = { scheduleNewYear, runNewYear };
