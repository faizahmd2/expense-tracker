#!/usr/bin/env node
// scripts/backup.js — Manual backup trigger
// Usage: npm run backup

require('dotenv').config({ path: require('path').join(__dirname, '../secrets.env') });

const { bootstrap } = require('../server/db/connection');
const { runBackup }  = require('../server/jobs/backup');

(async () => {
  await bootstrap();
  await runBackup();
  console.log('Backup complete.');
  process.exit(0);
})();