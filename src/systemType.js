'use strict';

const systems = require('../config/systems.json');
const business = require('../config/business.json');

/**
 * What has the caller actually got, and is it ours?
 *
 * This runs BEFORE any fault question, because the fault questions are gas boiler
 * questions — pilot lights, pressure, GC numbers. A storage heater has none of
 * those. Asking the wrong ones is worse than asking none: the caller can hear that
 * you don't understand what they own.
 *
 * Three outcomes, same shape as the postcode check: covered, not covered, unclear.
 * Never guess the trade — an unclear answer goes to the office, not to the diary.
 */

function normalise(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Whole words only.
 *
 * A naive substring test declines every gas boiler on the planet, because
 * "b-OIL-er" contains "oil". That would have turned away the most common caller
 * this company has, and the reply would have been a confident "we're gas only,
 * you'll need an OFTEC engineer".
 */
const cache = new Map();
function mentions(text, phrase) {
  let re = cache.get(phrase);
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Tolerate the plural: people say "storage heaters", "solar panels",
    // "radiators". Without this they fall through to "unclear" and get sent to
    // the office for something we could have answered on the spot.
    re = new RegExp(`(^|\\s)${escaped}e?s?(\\s|$)`, 'i');
    cache.set(phrase, re);
  }
  return re.test(text);
}

/**
 * @returns {{covered: true|false|"unclear", matched: string|null, say: string}}
 */
function check(description) {
  const text = normalise(description);

  if (!text) {
    return {
      covered: 'unclear',
      matched: null,
      say: "And what have you got there — a gas boiler, or something else?",
    };
  }

  // Not-covered wins over covered. "electric boiler" contains "boiler", and the
  // wrong answer there sends a gas engineer to something they can't legally touch.
  for (const item of systems.notCovered.items) {
    const hit = item.patterns.find((p) => mentions(text, p));
    if (hit) {
      return {
        covered: false,
        matched: hit,
        say: `Ah, ${item.say}. Sorry we can't help with that one.`,
      };
    }
  }

  const hit = systems.covered.patterns.find((p) => mentions(text, p));
  if (hit) return { covered: true, matched: hit, say: '' };

  return {
    covered: 'unclear',
    matched: null,
    say: `I'm not sure that's one for us, and I'd rather not send the wrong engineer out. Best thing is to ring the office on ${business.officePhone} and they'll tell you straight away.`,
  };
}

module.exports = { check };
