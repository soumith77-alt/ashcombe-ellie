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
const EVENT_TITLE = 'Engineer Visit';
const EVENT_SLUG = 'engineer-visit';

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

async function ensureEventType(scheduleId) {
  const list = await cal.getEventTypes();
  const existing = (list.json.data || []).find((e) => e.slug === EVENT_SLUG);
  if (existing) {
    console.log(`  event type "${EVENT_TITLE}" already exists -> id=${existing.id} (${existing.lengthInMinutes}min, scheduleId=${existing.scheduleId})`);
    return existing.id;
  }

  const r = await cal.call('/event-types', {
    method: 'POST',
    version: cal.API_VERSION.EVENT_TYPES,
    body: {
      title: EVENT_TITLE,
      slug: EVENT_SLUG,
      lengthInMinutes: business.slotLengthMinutes,
      description: 'Engineer attendance window booked by phone.',
      scheduleId,
      minimumBookingNotice: 120,
      slotInterval: 60,
      locations: [{ type: 'attendeeAddress' }],
      disableGuests: true,
    },
  });
  if (!r.ok) {
    console.error('  FAILED to create event type:', r.status, JSON.stringify(r.json).slice(0, 900));
    process.exit(1);
  }
  console.log(`  created event type -> id=${r.json.data.id} (${r.json.data.lengthInMinutes}min)`);
  return r.json.data.id;
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

(async () => {
  console.log('Cal.com setup');
  const scheduleId = await ensureSchedule();
  const eventTypeId = await ensureEventType(scheduleId);
  writeEnv({ CALCOM_SCHEDULE_ID: scheduleId, CALCOM_EVENT_TYPE_ID: eventTypeId });

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
