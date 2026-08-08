'use strict';

/**
 * The only file that holds the Cal.com API key.
 *
 * VERSIONS ARE PINNED PER ENDPOINT, NOT GLOBALLY. This is not a style choice —
 * verified against the live API:
 *
 *   GET /v2/slots    + 2024-09-04 -> 200 with slots
 *   GET /v2/slots    + no header  -> 404
 *   GET /v2/bookings + 2024-08-13 -> 200 with real bookings (and uid)
 *   GET /v2/bookings + 2024-06-14 -> 200 with {"bookings": []}   <-- SILENTLY EMPTY
 *   GET /v2/bookings + 2024-09-04 -> 404
 *
 * A single global constant would make find/reschedule/cancel silently return
 * "no booking found" forever, with no error anywhere to notice.
 */

const BASE = 'https://api.cal.com/v2';

const API_VERSION = {
  SLOTS: '2024-09-04',
  BOOKINGS: '2024-08-13',
  EVENT_TYPES: '2024-06-14',
  SCHEDULES: '2024-06-11',
};

function key() {
  const k = process.env.CALCOM_API_KEY;
  if (!k) throw new Error('CALCOM_API_KEY is not set');
  return k;
}

async function call(path, { method = 'GET', version, body, timeoutMs = 7000 } = {}) {
  if (!version) throw new Error(`cal-api-version must be pinned explicitly for ${path}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key()}`,
        'cal-api-version': version,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { _raw: text };
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { error: String(err && err.message) } };
  } finally {
    clearTimeout(timer);
  }
}

/** Free slots for a date range. Returns a flat array of ISO strings. */
async function getSlots({ eventTypeId, start, end, timeZone = 'Europe/London' }) {
  const qs = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    start,
    end,
    timeZone,
  });
  const r = await call(`/slots?${qs}`, { version: API_VERSION.SLOTS });
  if (!r.ok) return { ok: false, error: r.json, slots: [] };

  // Shape: { data: { "YYYY-MM-DD": [ { start: "ISO" }, ... ] } }
  const data = r.json && r.json.data ? r.json.data : {};
  const slots = [];
  for (const day of Object.keys(data)) {
    for (const s of data[day] || []) {
      if (s && s.start) slots.push(s.start);
    }
  }
  slots.sort();
  return { ok: true, slots };
}

async function createBooking({ eventTypeId, startIso, name, email, phone, timeZone = 'Europe/London', metadata, description }) {
  const body = {
    start: startIso,
    eventTypeId: Number(eventTypeId),
    attendee: {
      name,
      email,
      timeZone,
      language: 'en',
      ...(phone ? { phoneNumber: phone } : {}),
    },
    ...(description ? { bookingFieldsResponses: { notes: description } } : {}),
    ...(metadata ? { metadata } : {}),
  };
  const r = await call('/bookings', { method: 'POST', version: API_VERSION.BOOKINGS, body, timeoutMs: 8000 });
  return r;
}

async function getBookings(params = {}) {
  const qs = new URLSearchParams(params);
  return call(`/bookings?${qs}`, { version: API_VERSION.BOOKINGS });
}

async function rescheduleBooking(uid, { startIso, reason }) {
  return call(`/bookings/${uid}/reschedule`, {
    method: 'POST',
    version: API_VERSION.BOOKINGS,
    body: { start: startIso, reschedulingReason: reason || 'Caller rearranged by phone' },
    timeoutMs: 8000,
  });
}

async function cancelBooking(uid, reason) {
  return call(`/bookings/${uid}/cancel`, {
    method: 'POST',
    version: API_VERSION.BOOKINGS,
    body: { cancellationReason: reason || 'Cancelled by caller' },
    timeoutMs: 8000,
  });
}

async function getEventTypes() {
  return call('/event-types', { version: API_VERSION.EVENT_TYPES });
}

module.exports = {
  API_VERSION,
  call,
  getSlots,
  createBooking,
  getBookings,
  rescheduleBooking,
  cancelBooking,
  getEventTypes,
};
