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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is it safe to try this again?
 *
 * A GET can always be repeated. A write cannot: on a timeout or a 5xx the
 * booking may well have landed, and repeating it books the caller twice — the
 * one outcome worse than telling them to ring the office.
 *
 * The exception is 429. A rate limit means the request was rejected before it
 * was processed, so nothing was written and a retry is safe even for a POST.
 */
function safeToRetry(method, status) {
  if (status === 429) return true;
  const idempotent = method === 'GET';
  if (!idempotent) return false;
  return status === 0 || status >= 500;
}

async function once(path, { method, version, body, timeoutMs }) {
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
    return { ok: res.ok, status: res.status, json, retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    return { ok: false, status: 0, json: { error: String(err && err.message) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One transient blip used to become "I'm having trouble with the diary, could you
 * ring the office" — a lost customer for a hiccup that would have cleared in half
 * a second. Retries are bounded by the tool timeout: Telnyx gives us 9-10s and a
 * caller is sitting in silence throughout, so this buys one or two quick goes,
 * never a long stall.
 */
async function call(path, { method = 'GET', version, body, timeoutMs = 7000, attempts = 3 } = {}) {
  if (!version) throw new Error(`cal-api-version must be pinned explicitly for ${path}`);

  const deadline = Date.now() + Math.max(timeoutMs, 2000) + 2500;
  let last;

  for (let i = 0; i < attempts; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 300) break;

    last = await once(path, { method, version, body, timeoutMs: Math.min(timeoutMs, remaining) });
    if (last.ok) return last;
    if (!safeToRetry(method, last.status)) return last;
    if (i === attempts - 1) break;

    // Honour Retry-After when Cal.com sends one, but never wait past the deadline
    // — the caller hears silence for every millisecond of this.
    const suggested = Number(last.retryAfter) * 1000;
    const backoff = Number.isFinite(suggested) && suggested > 0 ? suggested : 400 * (i + 1);
    const wait = Math.min(backoff, Math.max(0, deadline - Date.now() - 300));
    if (wait <= 0) break;
    console.warn(`[calcom] ${method} ${path.split('?')[0]} -> ${last.status}, retrying in ${wait}ms`);
    await sleep(wait);
  }
  return last;
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
  safeToRetry,
  getSlots,
  createBooking,
  getBookings,
  rescheduleBooking,
  cancelBooking,
  getEventTypes,
};
