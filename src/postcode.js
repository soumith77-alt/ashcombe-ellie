'use strict';

const area = require('../config/service-area.json');
const business = require('../config/business.json');

/**
 * UK postcode outward-code matching.
 *
 * Three outcomes only: true, false, "unclear". We never guess a district in or out —
 * a wrong "yes" sends an engineer 200 miles; a wrong "no" turns away a real customer.
 */

// Full UK postcode, reasonably strict. Allows the inward half to be missing.
const FULL = /^([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})?$/i;

function normalise(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function outwardOf(raw) {
  const clean = normalise(raw);
  if (!clean) return null;
  // Insert the space back so the regex can split outward/inward reliably.
  const spaced = clean.length > 3 ? `${clean.slice(0, -3)} ${clean.slice(-3)}` : clean;
  const m = spaced.match(FULL);
  if (!m) return null;
  return m[1].toUpperCase();
}

function lettersOf(outward) {
  const m = String(outward || '').match(/^([A-Z]{1,2})/);
  return m ? m[1] : null;
}

/**
 * @returns {{inArea: true|false|"unclear", outward: string|null, say: string, reask: boolean}}
 */
function check(postcode, town) {
  const outward = outwardOf(postcode);

  // Nothing usable heard — re-ask rather than guess. (Mishearing test.)
  if (!outward) {
    const byTown = town && area.towns.inArea.includes(String(town).toLowerCase().trim());
    if (byTown) {
      return {
        inArea: 'unclear',
        outward: null,
        reask: true,
        say: "I didn't quite catch the postcode — could you give me that again, letter by letter?",
      };
    }
    return {
      inArea: 'unclear',
      outward: null,
      reask: true,
      say: "Sorry, I didn't quite catch that postcode — could you say it again for me, letter by letter?",
    };
  }

  if (area.inArea.includes(outward)) {
    return { inArea: true, outward, reask: false, say: 'Grand, we cover you there.' };
  }

  if (area.edge.districts.includes(outward)) {
    return {
      inArea: 'unclear',
      outward,
      reask: false,
      say: `I'm not certain that one's inside our patch. Best thing is to ring the office on ${business.officePhone} and they'll tell you straight away.`,
    };
  }

  const letters = lettersOf(outward);

  // Our letters but a district we don't list — edge of the patch, don't guess.
  if (area.areaLetters.includes(letters)) {
    return {
      inArea: 'unclear',
      outward,
      reask: false,
      say: `I'm not certain that one's inside our patch. Best thing is to ring the office on ${business.officePhone} and they'll tell you straight away.`,
    };
  }

  // Not our letters at all — definitively out.
  return {
    inArea: false,
    outward,
    reask: false,
    say: "Ah, I'm sorry — we don't get out that way, so I'd only be wasting your time taking the rest. You'll want a Gas Safe engineer local to you — the Gas Safe Register website will find you one. Sorry we couldn't help this time.",
  };
}

module.exports = { check, outwardOf, normalise };
