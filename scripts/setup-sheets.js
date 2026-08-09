'use strict';

/**
 * Verifies the service account can reach the sheet, then creates the tabs and
 * headers. Run once after sharing the sheet with the service-account address.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sheets = require('../src/sheets');

const KEY_FILE = path.join(__dirname, '..', 'config', 'google-service-account.json');

(async () => {
  if (!fs.existsSync(KEY_FILE)) {
    console.error('  no key file at config/google-service-account.json');
    process.exit(1);
  }
  const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  console.log('service account :', key.client_email);
  console.log('sheet id        :', process.env.GOOGLE_SHEET_ID || '(not set)');

  if (!process.env.GOOGLE_SHEET_ID) {
    console.error('\n  GOOGLE_SHEET_ID is not set in .env');
    process.exit(1);
  }

  try {
    await sheets.ensureTabs();
    console.log('\n  tabs ready: "Bookings" and "Call log", headers written, top row frozen');
  } catch (err) {
    const msg = String(err.message || err);
    if (/permission|403|forbidden/i.test(msg)) {
      console.error(`\n  PERMISSION DENIED — share the sheet with:\n     ${key.client_email}\n  (Share button, paste that address, give it Editor, untick "Notify people")`);
    } else if (/not found|404/i.test(msg)) {
      console.error('\n  Sheet not found — check GOOGLE_SHEET_ID is the long id from the URL');
    } else {
      console.error('\n  failed:', msg);
    }
    process.exit(1);
  }
})();
