'use strict';

/**
 * Proves the Gmail credentials work, then sends one real sample of each email so
 * the wording can be checked before a customer ever sees it.
 *
 *   node scripts/setup-email.js            # verify credentials only
 *   node scripts/setup-email.js --sample   # also send a sample pair
 */

require('dotenv').config();
const email = require('../src/email');
const state = require('../src/state');

(async () => {
  console.log('from    :', process.env.GMAIL_USER || '(not set)');
  console.log('manager :', process.env.MANAGER_EMAIL || '(not set)');

  if (!email.isEnabled()) {
    console.error('\n  GMAIL_USER and GMAIL_APP_PASSWORD must both be set in .env');
    console.error('  App password: myaccount.google.com/apppasswords (needs 2-Step Verification on)');
    process.exit(1);
  }

  try {
    await email.verify();
    console.log('\n  credentials OK — Gmail accepted the login');
  } catch (err) {
    console.error('\n  Gmail rejected the login:', err.message);
    console.error('  A normal account password will not work; it must be a 16-character app password.');
    process.exit(1);
  }

  if (!process.argv.includes('--sample')) {
    console.log('  (run with --sample to send one of each)');
    return;
  }

  const s = state.get('email-sample', '+447700900123');
  Object.assign(s.location, { addressLine1: '14 Oak Road', addressExtra: 'Didsbury', postcode: 'M20 2RT', inArea: true });
  s.lane = 'repair'; s.systemType = 'Worcester Bosch combi'; s.callerRelationship = 'owner';
  Object.assign(s.diagnostics, {
    issueType: 'repair', fault: 'no hot water, heating still on',
    makeModel: 'Worcester Bosch combi', gcOrErrCode: 'F28', symptoms: 'water underneath it',
  });
  Object.assign(s.contact, {
    name: 'Sample Customer', phone: '07700 900123',
    email: process.env.GMAIL_USER,
  });

  email.sendBooked(s, 'Wednesday the 12th at 8am');
  await email.flush();
  console.log('  sent: customer sample -> ' + process.env.GMAIL_USER);
  console.log('  sent: manager sample  -> ' + process.env.MANAGER_EMAIL);
})();
