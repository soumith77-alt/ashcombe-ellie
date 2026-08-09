'use strict';

/**
 * Prints the environment variables to paste into the host, reading them from the
 * local .env so nothing is retyped or mistranscribed.
 *
 * The Google key is a FILE locally and gitignored, so it cannot travel with the
 * repo — it is emitted here base64-encoded for GOOGLE_SERVICE_ACCOUNT_JSON.
 *
 *   node scripts/deploy-env.js           # names only, safe to screenshot
 *   node scripts/deploy-env.js --values  # with secrets, for pasting
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const withValues = process.argv.includes('--values');
const KEY_FILE = path.join(__dirname, '..', 'config', 'google-service-account.json');

const vars = {
  CALCOM_API_KEY: process.env.CALCOM_API_KEY,
  CALCOM_EVENT_TYPE_ID: process.env.CALCOM_EVENT_TYPE_ID,
  CALCOM_SCHEDULE_ID: process.env.CALCOM_SCHEDULE_ID,
  TELNYX_API_KEY: process.env.TELNYX_API_KEY,
  TELNYX_ASSISTANT_ID: process.env.TELNYX_ASSISTANT_ID,
  MANAGER_EMAIL: process.env.MANAGER_EMAIL,
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON: fs.existsSync(KEY_FILE)
    ? fs.readFileSync(KEY_FILE).toString('base64')
    : '',
};

console.log(`\n${Object.keys(vars).length} variables for the host:\n`);
for (const [k, v] of Object.entries(vars)) {
  if (withValues) console.log(`${k}=${v || ''}`);
  else console.log(`  ${k.padEnd(30)} ${v ? `set (${String(v).length} chars)` : 'MISSING'}`);
}

console.log(`
  PORT is provided by the host — do not set it.
  PUBLIC_BASE_URL must be set to the deployed URL AFTER the first deploy,
  then re-run setup:telnyx and setup:calcom so the webhooks point at it.
`);
if (!withValues) console.log('  Re-run with --values to print the secrets for pasting.\n');
