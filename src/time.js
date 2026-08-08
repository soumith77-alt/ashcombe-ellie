'use strict';

const business = require('../config/business.json');
const TZ = business.timezone; // Europe/London

/**
 * Every date/time decision in this service happens here, in Europe/London.
 *
 * The offset is computed from the instant, so BST/GMT handles itself and nothing
 * upstream ever needs to know which one is in force. The LLM never emits an offset
 * and never sees an ISO string.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Wall-clock parts for an instant, in London. */
function parts(date) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'long',
  });
  const out = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: out.weekday.toLowerCase(),
    dow: WEEKDAYS.indexOf(out.weekday.toLowerCase()),
  };
}

/** Offset of the London zone at a given instant, in ms. */
function offsetMsAt(date) {
  const p = parts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  // Compare at minute granularity so stray seconds can't skew the offset.
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}

/** London wall-clock -> UTC instant. Settles DST by re-checking once. */
function fromLondonWallClock(y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let instant = guess - offsetMsAt(new Date(guess));
  instant = guess - offsetMsAt(new Date(instant));
  return new Date(instant);
}

function ymd(date) {
  const p = parts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function addDays(date, n) {
  const p = parts(date);
  return fromLondonWallClock(p.year, p.month, p.day + n, p.hour, p.minute);
}

function isBookingDay(date) {
  return business.bookingHours.days.includes(parts(date).dow);
}

/**
 * Resolve what the caller said into a concrete London date.
 * Returns null when we genuinely can't tell — the agent then re-asks.
 */
function resolveDay(dayPreference, now = new Date()) {
  const text = String(dayPreference || '').toLowerCase().trim();
  if (!text) return null;

  if (/\btoday\b|\bthis afternoon\b|\bthis morning\b/.test(text)) return ymd(now);
  if (/\btomorrow\b/.test(text)) return ymd(addDays(now, 1));
  if (/day after tomorrow/.test(text)) return ymd(addDays(now, 2));

  // "the 12th", "12th of August"
  const dom = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dom) {
    const target = Number(dom[1]);
    for (let i = 0; i < 40; i++) {
      const cand = addDays(now, i);
      if (parts(cand).day === target) return ymd(cand);
    }
  }

  const wantsNextWeek = /\bnext\b/.test(text);
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (text.includes(WEEKDAYS[i])) {
      const todayDow = parts(now).dow;
      let delta = (i - todayDow + 7) % 7;
      if (delta === 0) delta = 7; // "Wednesday" said on a Wednesday means the next one
      if (wantsNextWeek && delta < 7) delta += 7;
      return ymd(addDays(now, delta));
    }
  }

  if (/next week/.test(text)) return ymd(addDays(now, 7));
  if (/\basap|soon|earliest|any\b/.test(text)) return ymd(now);

  return null;
}

/** morning | afternoon | any */
function resolveTimePreference(timePreference) {
  const t = String(timePreference || '').toLowerCase();
  if (/morning|early|first thing|am\b/.test(t)) return 'morning';
  if (/afternoon|later|pm\b|after lunch/.test(t)) return 'afternoon';
  return 'any';
}

function withinBookingHours(date) {
  const p = parts(date);
  if (!business.bookingHours.days.includes(p.dow)) return false;
  // The engineer's attendance window must start early enough to finish by close.
  const endsAt = p.hour + business.slotLengthMinutes / 60;
  return p.hour >= business.bookingHours.startHour && endsAt <= business.bookingHours.endHour;
}

function matchesTimePreference(date, pref) {
  if (pref === 'any') return true;
  const h = parts(date).hour;
  return pref === 'morning' ? h < 12 : h >= 12;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** "Wednesday the 12th at 9am" — what the caller hears. Never an ISO string. */
function spokenLabel(isoString) {
  const d = new Date(isoString);
  const p = parts(d);
  const weekday = p.weekday.charAt(0).toUpperCase() + p.weekday.slice(1);
  const suffix = p.hour < 12 ? 'am' : 'pm';
  let h12 = p.hour % 12;
  if (h12 === 0) h12 = 12;
  const time = p.minute === 0 ? `${h12}${suffix}` : `${h12}:${String(p.minute).padStart(2, '0')}${suffix}`;
  return `${weekday} the ${ordinal(p.day)} at ${time}`;
}

module.exports = {
  TZ,
  parts,
  ymd,
  addDays,
  isBookingDay,
  resolveDay,
  resolveTimePreference,
  withinBookingHours,
  matchesTimePreference,
  spokenLabel,
  fromLondonWallClock,
  ordinal,
};
