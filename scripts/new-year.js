#!/usr/bin/env node
// scripts/new-year.js — Manual new-year trigger
// Usage: npm run new-year

require('dotenv').config({ path: require('path').join(__dirname, '../secrets.env') });

const { bootstrap }   = require('../server/db/connection');
const { runNewYear }  = require('../server/jobs/newYear');

(async () => {
  await bootstrap();
  await runNewYear();
  process.exit(0);
})();
