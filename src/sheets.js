'use strict';

/**
 * Google Sheets — the office's copy of the diary.
 *
 * Two tabs:
 *   Bookings  — one row per booking, UPDATED IN PLACE when a visit is moved or
 *               cancelled, so the sheet never shows a visit that isn't happening.
 *   Call log  — one row per call that didn't end in a booking: out of area,
 *               emergency, or hung up part way. This is what answers "how many
 *               callers did we turn away" without reading transcripts.
 *
 * WRITES NEVER BLOCK A CALL. Every write is queued and flushed in the background:
 * if Google is slow or down, the caller still gets booked and the row lands late.
 * A booking that exists in Cal.com but not in the sheet is a nuisance; a caller
 * held in silence because a spreadsheet was slow is a lost customer.
 */

const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, '..', 'config', 'google-service-account.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const BOOKINGS = 'Bookings';
const CALL_LOG = 'Call log';

const BOOKING_HEADERS = [
  'Booked at', 'Status', 'Appointment', 'Name', 'Phone', 'Email',
  'Address', 'Postcode', 'Lane', 'Caller', 'System', 'Job type', 'Fault',
  'Make & model', 'Code', 'Symptoms', 'Engineer notes', 'Cal.com UID', 'Call ref',
];

const CALL_HEADERS = [
  'At', 'Outcome', 'Reason', 'Phone', 'Postcode', 'In area',
  'Gate A', 'Gate B', 'Captured', 'Call ref',
];

let client = null;
let enabled = null;

function spreadsheetId() {
  return process.env.GOOGLE_SHEET_ID || null;
}

/**
 * Credentials come from a file locally and from an env var when deployed.
 *
 * The key file is gitignored — correctly — so it does not exist on a host that
 * deploys from the repo. GOOGLE_SERVICE_ACCOUNT_JSON carries the same JSON,
 * raw or base64, and takes precedence. Without this the integration silently
 * disables itself in production and nobody notices until the sheet stays empty.
 */
function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  }
  if (fs.existsSync(KEY_FILE)) return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  return null;
}

/** Off unless we have both a sheet id and usable credentials. */
function isEnabled() {
  if (enabled === null) {
    let creds = null;
    try { creds = credentials(); } catch (err) {
      console.error('[sheets] credentials unreadable:', err.message);
    }
    enabled = Boolean(spreadsheetId()) && Boolean(creds);
    if (!enabled) {
      console.log(`[sheets] disabled (sheet id: ${spreadsheetId() ? 'set' : 'missing'}, credentials: ${creds ? 'ok' : 'missing'})`);
    }
  }
  return enabled;
}

async function api() {
  if (client) return client;
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: SCOPES });
  client = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return client;
}

/* ------------------------------------------------------------------ tabs */

async function ensureTabs() {
  const sheets = await api();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  const have = meta.data.sheets.map((s) => s.properties.title);

  const wanted = [[BOOKINGS, BOOKING_HEADERS], [CALL_LOG, CALL_HEADERS]];
  const missing = wanted.filter(([title]) => !have.includes(title));

  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: missing.map(([title]) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  // Write headers on any tab that is empty, and freeze the row.
  for (const [title, headers] of wanted) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId(),
      range: `${title}!A1:A1`,
    });
    if (!res.data.values || !res.data.values.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId(),
        range: `${title}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });
    }
  }

  const fresh = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: fresh.data.sheets
        .filter((s) => [BOOKINGS, CALL_LOG].includes(s.properties.title))
        .map((s) => ({
          updateSheetProperties: {
            properties: { sheetId: s.properties.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        })),
    },
  });

  return true;
}

/* ------------------------------------------------------------- the queue */

const queue = [];
let flushing = false;

function record(job) {
  if (!isEnabled()) return;
  queue.push({ ...job, attempts: 0 });
  setImmediate(flush);
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const job = queue[0];
      try {
        await run(job);
        queue.shift();
      } catch (err) {
        job.attempts += 1;
        console.error(`[sheets] ${job.type} failed (attempt ${job.attempts}):`, err.message);
        if (job.attempts >= 3) {
          queue.shift(); // give up rather than block everything behind it
          console.error('[sheets] giving up on', job.type, job.uid || '');
        } else {
          await new Promise((r) => setTimeout(r, 800 * job.attempts));
        }
      }
    }
  } finally {
    flushing = false;
  }
}

async function run(job) {
  if (job.type === 'booking') return appendBooking(job.row);
  if (job.type === 'status') return updateStatus(job.uid, job.status, job.appointment, job.newUid);
  if (job.type === 'call') return appendCall(job.row);
}

async function append(tab, values) {
  const sheets = await api();
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${tab}!A1`,
    // RAW, not USER_ENTERED: Sheets parses "+447700900555" as a formula and
    // stores 447700900555, dropping the country prefix. An engineer ringing a
    // customer back on a mangled number is exactly the kind of quiet data loss
    // nobody notices until it matters.
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

const appendBooking = (row) => append(BOOKINGS, row);
const appendCall = (row) => append(CALL_LOG, row);

/** Find the booking row by Cal.com uid and rewrite its status and slot. */
async function updateStatus(uid, status, appointment, newUid) {
  const sheets = await api();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${BOOKINGS}!R:R`, // Cal.com UID column
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => r[0] === uid);
  if (idx === -1) {
    console.warn('[sheets] no row for uid', uid);
    return;
  }
  const rowNumber = idx + 1;

  const updates = [{ range: `${BOOKINGS}!B${rowNumber}`, values: [[status]] }];
  if (appointment) updates.push({ range: `${BOOKINGS}!C${rowNumber}`, values: [[appointment]] });
  // A reschedule mints a new uid; keep the row findable next time.
  if (newUid && newUid !== uid) updates.push({ range: `${BOOKINGS}!R${rowNumber}`, values: [[newUid]] });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
}

/* --------------------------------------------------------- public shapes */

const nowIso = () => new Date().toISOString();
const clean = (v) => (v === null || v === undefined ? '' : String(v));

function logBooking(state, label, engineerNotes) {
  record({
    type: 'booking',
    uid: state.bookingUid,
    row: [
      nowIso(), 'Booked', clean(label),
      clean(state.contact.name), clean(state.contact.phone), clean(state.contact.email),
      clean(state.location.addressLine1),
      clean(state.location.postcode),
      clean(state.lane), clean(state.callerRelationship), clean(state.systemType),
      clean(state.diagnostics.issueType || state.diagnostics.serviceType),
      clean(state.diagnostics.fault),
      clean(state.diagnostics.makeModel), clean(state.diagnostics.gcOrErrCode),
      clean(state.diagnostics.symptoms),
      clean(engineerNotes), clean(state.bookingUid), clean(state.conversationId),
    ],
  });
}

function logStatusChange(uid, status, appointment, newUid) {
  record({ type: 'status', uid, status, appointment, newUid });
}

function logCall(state, outcome, reason) {
  const captured = [
    state.location.postcode && `postcode ${state.location.postcode}`,
    state.lane && `lane ${state.lane}`,
    state.systemType && `system ${state.systemType}`,
    state.diagnostics.issueType && `job ${state.diagnostics.issueType}`,
    state.diagnostics.fault && `fault ${state.diagnostics.fault}`,
  ].filter(Boolean).join('; ');

  record({
    type: 'call',
    row: [
      nowIso(), clean(outcome), clean(reason),
      clean(state.callerNumber), clean(state.location.postcode), clean(state.location.inArea),
      String(require('./state').gateA(state)), String(require('./state').gateB(state)),
      captured, clean(state.conversationId),
    ],
  });
}

module.exports = {
  isEnabled, ensureTabs, record, flush,
  logBooking, logStatusChange, logCall,
  BOOKINGS, CALL_LOG, BOOKING_HEADERS, CALL_HEADERS,
  _queue: queue,
};
