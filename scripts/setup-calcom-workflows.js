'use strict';

/**
 * Cal.com Workflows — the emails.
 *
 * Verified the hard way: this account sends NO booking emails at all. Google
 * Calendar is connected and the events are created correctly, but nothing reaches
 * an inbox — tested with a plus-address so the attendee differed from the account
 * owner, and checked including spam and trash. Meanwhile Ellie tells every caller
 * "you'll get a confirmation email through in the next few minutes".
 *
 * The reason is that the account has no workflows. These create them:
 *
 *   1. Customer confirmation  — email_attendee on newEvent
 *   2. Manager notification   — email_address on newEvent
 *   3. Manager, rescheduled   — email_address on rescheduleEvent
 *   4. Manager, cancelled     — email_address on eventCancelled
 *
 * The engineer's job description already rides along in the booking notes, so the
 * manager gets the fault, make and code without any of it being re-templated here.
 *
 * Safe to re-run: workflows are matched by name and skipped if present.
 */

require('dotenv').config();
const business = require('../config/business.json');

const API = 'https://api.cal.com/v2';
const VERSION = '2024-06-14';
const KEY = process.env.CALCOM_API_KEY;
const EVENT_TYPE_ID = Number(process.env.CALCOM_EVENT_TYPE_ID);
const MANAGER = process.env.MANAGER_EMAIL;

if (!KEY) throw new Error('CALCOM_API_KEY not set');
if (!EVENT_TYPE_ID) throw new Error('CALCOM_EVENT_TYPE_ID not set — run setup:calcom first');
if (!MANAGER) throw new Error('MANAGER_EMAIL not set');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'cal-api-version': VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

const SENDER = business.businessName;

/** Cal.com templates: reminder | custom | rescheduled | completed | rating | cancelled */
const WORKFLOWS = [
  {
    name: 'Ellie — customer confirmation',
    trigger: { type: 'newEvent' },
    step: { action: 'email_attendee', recipient: 'attendee', template: 'reminder' },
  },
  {
    name: 'Ellie — manager: new booking',
    trigger: { type: 'newEvent' },
    step: { action: 'email_address', recipient: 'email', template: 'reminder', email: MANAGER },
  },
  {
    name: 'Ellie — manager: rescheduled',
    trigger: { type: 'rescheduleEvent' },
    step: { action: 'email_address', recipient: 'email', template: 'rescheduled', email: MANAGER },
  },
  {
    name: 'Ellie — manager: cancelled',
    trigger: { type: 'eventCancelled' },
    step: { action: 'email_address', recipient: 'email', template: 'cancelled', email: MANAGER },
  },
];

(async () => {
  console.log(`Cal.com workflows  (event type ${EVENT_TYPE_ID}, manager ${MANAGER})`);

  const list = await api('/workflows');
  const existing = (list.json.data || []).map((w) => w.name);

  for (const w of WORKFLOWS) {
    if (existing.includes(w.name)) {
      console.log(`  exists  ${w.name}`);
      continue;
    }
    const r = await api('/workflows', {
      method: 'POST',
      body: {
        name: w.name,
        activeOn: [EVENT_TYPE_ID],
        trigger: w.trigger,
        steps: [{ stepNumber: 1, sender: SENDER, ...w.step }],
      },
    });
    console.log(r.ok
      ? `  created ${w.name} -> ${(r.json.data || {}).id}`
      : `  FAILED  ${w.name}: ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  }

  const after = await api('/workflows');
  console.log(`\n  ${(after.json.data || []).length} workflow(s) now active`);
})();
