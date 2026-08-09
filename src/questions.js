'use strict';

const { missingFields } = require('./state');
const business = require('../config/business.json');

/**
 * Maps an outstanding field to the exact line Ellie should say next.
 *
 * This is the return path for Bug 1. An FAQ is a detour, not a branch: after
 * answering "what time do you open?", the next sentence is whatever this returns —
 * never "shall I check some times for you?".
 */
const LINES = {
  // opening checks, in order
  postcode:
    "Before we go any further — whereabouts is the property? If you give me the postcode I'll check we cover you.",
  // One question, and the town is never asked for. Hunting for a "full address"
  // was what stalled callers who had already given everything an engineer needs.
  addressLine1:
    "And what's the address? Just the house number and street is fine, I've got the postcode.",
  systemType:
    "And what have you got there — a gas boiler, or something else?",
  callerRelationship:
    "And is it your own place, or are you calling as a tenant or a landlord?",
  lane:
    "And is this something that's broken, a service, or were you looking at a new boiler?",

  // repair lane
  fault:
    "Right — and what's it actually doing at the moment?",
  makeModel:
    'Do you know what make it is? Worcester, Baxi, Vaillant, that sort of thing.',
  symptoms:
    "Anything else you've noticed? Water underneath it, warning lights, pilot light out?",

  // service lane — never fault questions
  serviceType:
    "Is that a service you're after, or a landlord's gas safety certificate?",
  applianceCount:
    'Is it just the boiler, or is there a fire or a hob as well?',

  // new boiler lane — ends in a survey, never a price
  currentSystem:
    "What have you got at the moment — a combi, a system boiler, a back boiler? And roughly how old is it?",
  bedrooms:
    'How many bedrooms and bathrooms has the property got?',
};

/** The one follow-up probe that fits the fault described. */
const PROBES = [
  { match: /hot water/i, say: 'Is the heating still working alright, or is that off too?' },
  { match: /no heat|not heating|cold rad|heating.*(off|not)/i, say: 'Are all the radiators cold, or just some of them?' },
  { match: /leak|drip|water/i, say: 'Is that coming from the boiler itself or a pipe? Dripping, or running?' },
  { match: /noise|bang|whistl|kettl|gurgl|hum/i, say: 'How would you describe it — banging, whistling, kettling? Only when it fires up, or all the time?' },
  { match: /dead|no display|won'?t turn on|nothing/i, say: 'Is there anything at all showing on the display?' },
];

function probeFor(fault) {
  if (!fault) return null;
  const hit = PROBES.find((p) => p.match.test(fault));
  return hit ? hit.say : null;
}

/**
 * The next thing to say. Order matters — location before boiler, always.
 */
function nextQuestion(state) {
  const missing = missingFields(state);

  if (state.emergency) {
    return {
      missing,
      say: `We can't book anything while there's a safety issue at the property. Once it's been made safe, ring the office on ${business.officePhone} and we'll sort a visit.`,
    };
  }

  // A system we don't cover, or can't identify. Decline before taking details.
  if (missing.includes('systemCheck')) {
    const covered = state.systemCovered;
    return {
      missing,
      say: covered === false
        ? "That's not one for us I'm afraid, so I'd only be wasting your time taking the rest."
        : `I'm not sure that's one for us, and I'd rather not send the wrong engineer out. Best ring the office on ${business.officePhone}.`,
    };
  }

  // Area check resolved to something other than a clean yes.
  if (missing.includes('areaCheck')) {
    if (state.location.inArea === false) {
      return {
        missing,
        say: "I'm sorry — we don't get out that way. You'll want a Gas Safe engineer local to you; the Gas Safe Register website will find you one.",
      };
    }
    return {
      missing,
      say: `I'm not certain that one's inside our patch. Best thing is to ring the office on ${business.officePhone} and they'll tell you straight away.`,
    };
  }

  const first = missing[0];
  if (!first) {
    return {
      missing: [],
      say: "Right, let's get you booked in. What day suits you, and are you better morning or afternoon?",
    };
  }

  // The fault probe is a follow-up, not a gate — ask it once we have a fault
  // but before moving on to make and model.
  if (first === 'makeModel' && state.lane === 'repair' &&
      state.diagnostics.fault && !state.diagnostics.probeAnswer) {
    const probe = probeFor(state.diagnostics.fault);
    if (probe) return { missing, say: probe };
  }

  return { missing, say: LINES[first] };
}

module.exports = { nextQuestion, probeFor, LINES };
