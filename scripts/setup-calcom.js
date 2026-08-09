'use strict';

/**
 * Idempotent Cal.com setup.
 *
 * The account's default schedule is Asia/Kolkata, 7 days a week, 07:00-17:15 +
 * 21:00-23:30. Left alone, /v2/slots offers a UK heating engineer 02:30 in the
 * morning. This creates a proper Europe/London Mon-Fri 08:00-17:00 schedule and a
 * 120-minute "Engineer Visit" event type bound to it.
 *
 * Safe to re-run: it reuses anything already named correctly.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cal = require('../src/calcom');
const business = require('../config/business.json');

const SCHEDULE_NAME = 'Ashcombe Engineers';

/**
 * One appointment type per lane. A survey is a sales visit and rarely needs two
 * hours; a certificate is shorter than a breakdown. Booking everything into the
 * same 120-minute slot fills the diary faster than the work actually does, and
 * the office can't tell a 20-minute certificate from a two-hour repair.
 */
const EVENT_TYPES = [
  { key: 'CALCOM_EVENT_TYPE_ID',      title: 'Engineer Visit',      slug: 'engineer-visit', minutes: 120,
    description: 'Repair — engineer attendance window booked by phone.' },
  { key: 'CALCOM_EVENT_TYPE_SERVICE', title: 'Service / Certificate', slug: 'service-visit',  minutes: 90,
    description: 'Annual service or landlord gas safety certificate.' },
  { key: 'CALCOM_EVENT_TYPE_SURVEY',  title: 'New Boiler Survey',   slug: 'boiler-survey',  minutes: 60,
    description: 'Free, no-obligation survey and fixed quote for a new boiler.' },
];

async function ensureSchedule() {
  const list = await cal.call('/schedules', { version: cal.API_VERSION.SCHEDULES });
  const existing = (list.json.data || []).find((s) => s.name === SCHEDULE_NAME);
  if (existing) {
    console.log(`  schedule "${SCHEDULE_NAME}" already exists -> id=${existing.id} (${existing.timeZone})`);
    return existing.id;
  }

  const r = await cal.call('/schedules', {
    method: 'POST',
    version: cal.API_VERSION.SCHEDULES,
    body: {
      name: SCHEDULE_NAME,
      timeZone: business.timezone,
      isDefault: false,
      availability: [
        {
          days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          startTime: '08:00',
          endTime: '17:00',
        },
      ],
    },
  });
  if (!r.ok) {
    console.error('  FAILED to create schedule:', r.status, JSON.stringify(r.json).slice(0, 600));
    process.exit(1);
  }
  console.log(`  created schedule -> id=${r.json.data.id} (${r.json.data.timeZone})`);
  return r.json.data.id;
}

async function ensureEventTypes(scheduleId) {
  const list = await cal.getEventTypes();
  const have = list.json.data || [];
  const ids = {};

  for (const t of EVENT_TYPES) {
    const existing = have.find((e) => e.slug === t.slug);
    if (existing) {
      console.log(`  event type "${t.title}" exists -> id=${existing.id} (${existing.lengthInMinutes}min)`);
      ids[t.key] = existing.id;
      continue;
    }
    const r = await cal.call('/event-types', {
      method: 'POST',
      version: cal.API_VERSION.EVENT_TYPES,
      body: {
        title: t.title,
        slug: t.slug,
        lengthInMinutes: t.minutes,
        description: t.description,
        scheduleId,
        minimumBookingNotice: 120,
        slotInterval: 60,
        locations: [{ type: 'attendeeAddress' }],
        disableGuests: true,
      },
    });
    if (!r.ok) {
      console.error(`  FAILED to create "${t.title}":`, r.status, JSON.stringify(r.json).slice(0, 600));
      process.exit(1);
    }
    console.log(`  created "${t.title}" -> id=${r.json.data.id} (${r.json.data.lengthInMinutes}min)`);
    ids[t.key] = r.json.data.id;
  }
  return ids;
}

function writeEnv(kv) {
  const p = path.join(__dirname, '..', '.env');
  let text = fs.readFileSync(p, 'utf8');
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}\n${k}=${v}`;
  }
  fs.writeFileSync(p, text);
  console.log('  .env updated');
}

/**
 * Keeps our view of the diary true when the office moves something by hand.
 * Skipped when there's no public URL yet — the tunnel changes between sessions.
 */
async function ensureWebhook() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    console.log('  webhook: skipped (PUBLIC_BASE_URL not set)');
    return;
  }
  const subscriberUrl = `${base}/webhooks/calcom`;
  const triggers = ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'];

  const list = await cal.call('/webhooks', { version: cal.API_VERSION.EVENT_TYPES });
  const existing = (list.json.data || []).find((w) => w.subscriberUrl === subscriberUrl);
  if (existing) {
    console.log(`  webhook already registered -> ${existing.id}`);
    return;
  }

  // Drop stale tunnels from previous sessions so they don't pile up.
  for (const w of list.json.data || []) {
    if (/trycloudflare\.com|ngrok/.test(w.subscriberUrl || '')) {
      await cal.call(`/webhooks/${w.id}`, { method: 'DELETE', version: cal.API_VERSION.EVENT_TYPES });
      console.log(`  removed stale webhook ${w.id}`);
    }
  }

  const r = await cal.call('/webhooks', {
    method: 'POST',
    version: cal.API_VERSION.EVENT_TYPES,
    body: { subscriberUrl, triggers, active: true, payloadTemplate: null },
  });
  console.log(r.ok
    ? `  webhook registered -> ${subscriberUrl}`
    : `  webhook registration failed: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
}

(async () => {
  console.log('Cal.com setup');
  const scheduleId = await ensureSchedule();
  const ids = await ensureEventTypes(scheduleId);
  const eventTypeId = ids.CALCOM_EVENT_TYPE_ID;
  writeEnv({ CALCOM_SCHEDULE_ID: scheduleId, ...ids });
  await ensureWebhook();

  console.log('\nVerifying slots come back in London booking hours...');
  const { ymd, addDays, parts } = require('../src/time');
  const now = new Date();
  const r = await cal.getSlots({
    eventTypeId,
    start: ymd(now),
    end: ymd(addDays(now, 9)),
  });
  if (!r.ok) {
    console.error('  slots lookup failed:', JSON.stringify(r.error).slice(0, 400));
    process.exit(1);
  }
  const hours = new Set();
  const days = new Set();
  for (const iso of r.slots) {
    const p = parts(new Date(iso));
    hours.add(p.hour);
    days.add(p.weekday);
  }
  console.log('  slot count:', r.slots.length);
  console.log('  distinct start hours (London):', [...hours].sort((a, b) => a - b).join(', '));
  console.log('  days present:', [...days].join(', '));
  console.log('  first 3:', r.slots.slice(0, 3).join('  '));
})();
