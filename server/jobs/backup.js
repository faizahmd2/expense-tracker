'use strict';

/**
 * jobs/backup.js
 *
 * Nightly backup job — runs via node-cron.
 * Flushes the active SQLite file to disk, then copies it
 * to the iCloud backup folder with a datestamped filename.
 * Also prunes old backups beyond BACKUP_RETAIN_DAYS.
 */

const path = require('path');
const fs   = require('fs');
const fse  = require('fs-extra');
const cron = require('node-cron');
const { format } = require('date-fns');

const { flushYear, dbPath } = require('../db/connection');
const config = require('../../config.json');

// ─── Schedule ─────────────────────────────────────────────────────────────────

function scheduleBackup() {
  const schedule = config.backup?.cron ?? '0 2 * * *';  // default: 2am daily

  cron.schedule(schedule, async () => {
    console.log('[backup] Starting nightly backup...');
    try {
      await runBackup();
      console.log('[backup] Backup complete.');
    } catch (err) {
      console.error('[backup] Backup failed:', err.message);
    }
  });

  console.log(`[backup] Scheduled with cron: "${schedule}"`);
}

// ─── Core backup logic ────────────────────────────────────────────────────────

async function runBackup() {
  const icloudDir   = process.env.ICLOUD_BACKUP_DIR;
  const retainDays  = parseInt(process.env.BACKUP_RETAIN_DAYS ?? '90', 10);
  const activeYear  = config.active_year;

  if (!icloudDir) {
    console.warn('[backup] ICLOUD_BACKUP_DIR not set — skipping iCloud copy.');
    return;
  }

  fse.ensureDirSync(icloudDir);

  // 1. Flush in-memory db to disk first
  flushYear(activeYear);

  // 2. Copy to iCloud with datestamp
  const sourceFile = dbPath(activeYear);
  const dateStamp  = format(new Date(), 'yyyy-MM-dd');
  const destFile   = path.join(icloudDir, `db-${activeYear}-${dateStamp}.sqlite`);

  fse.copyFileSync(sourceFile, destFile);
  console.log(`[backup] Copied → ${destFile}`);

  // 3. Prune old backups
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retainDays);

  const allBackups = fs.readdirSync(icloudDir)
    .filter(f => f.startsWith(`db-${activeYear}-`) && f.endsWith('.sqlite'))
    .sort();

  let pruned = 0;
  for (const file of allBackups) {
    const datePart = file.replace(`db-${activeYear}-`, '').replace('.sqlite', '');
    const fileDate = new Date(datePart);

    if (!isNaN(fileDate) && fileDate < cutoff) {
      fs.unlinkSync(path.join(icloudDir, file));
      pruned++;
    }
  }

  if (pruned > 0) console.log(`[backup] Pruned ${pruned} old backup(s).`);
}

module.exports = { scheduleBackup, runBackup };
