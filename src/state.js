'use strict';

/**
 * Per-call conversation state.
 *
 * The gates are the product. They are COMPUTED from captured fields and are not
 * settable by anything — not the LLM, not a tool handler. A prompt rule alone gets
 * skipped under pressure (see the previous build); this is the backstop that does not.
 */

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const store = new Map();

/**
 * What each lane must have answered before it may look at the diary.
 *
 * One list for every caller was the old mistake: it asked someone booking an annual
 * service what fault their boiler had, and it locked the service and new-boiler
 * lanes out of the diary entirely, because they are told not to ask fault questions.
 * "not given" still counts as answered everywhere — a caller who doesn't know has
 * still answered.
 */
const LANE_FIELDS = {
  repair:    ['fault', 'makeModel', 'symptoms'],
  service:   ['serviceType', 'applianceCount'],
  newBoiler: ['currentSystem', 'bedrooms'],
  existing:  [],
  emergency: [],
};

const LANES = Object.keys(LANE_FIELDS);

/** Asked after a slot is chosen, in this order. */
const CONTACT_FIELDS = ['name', 'phone', 'email'];

/**
 * The loop breaker.
 *
 * Asked twice and still empty, a question is not going to be answered by asking a
 * third time. Soft fields are the ones the brief already lets a caller leave blank
 * — none of them stops an engineer working, so we record "not given" and move on.
 * Hard blockers genuinely prevent a visit, so we stop and hand to the office
 * rather than trapping someone in the same question forever.
 */
const MAX_ASKS = 2;
const SOFT_FIELDS = new Set([
  'makeModel', 'symptoms', 'callerRelationship',
  'applianceCount', 'bedrooms', 'duration', 'previousWork',
]);
const HARD_BLOCKERS = new Set([
  'postcode', 'addressLine1', 'fault', 'serviceType', 'currentSystem',
  'systemType',  // we cannot send an engineer to something we can't identify
  'lane',        // if we can't tell what they want, we can't book the right visit
  // A booking genuinely cannot exist without these: Cal.com requires an email,
  // and the office needs a name and number to ring about the arrival window.
  'name', 'phone', 'email',
]);

/**
 * Record that we asked for `field` and got nothing new. Returns what to do:
 * "ask" (carry on), "fill" (accept not given), or "stop" (hand to the office).
 */
function noteAsked(state, field) {
  if (!field) return 'ask';
  state.asked[field] = (state.asked[field] || 0) + 1;
  if (state.asked[field] <= MAX_ASKS) return 'ask';

  if (SOFT_FIELDS.has(field)) {
    if (field === 'callerRelationship') state.callerRelationship = 'not given';
    else state.diagnostics[field] = 'not given';
    return 'fill';
  }
  // Anything not explicitly soft stops the loop. Defaulting to "keep asking" is
  // what let `lane` repeat forever after the first two loops were fixed — the
  // same bug, one field along. Failing closed means a new field added tomorrow
  // degrades into an office handoff rather than trapping a caller.
  state.stuck = field;
  return 'stop';
}

// Kept for the repair lane's own question set and for older callers of this module.
const DIAGNOSTIC_FIELDS = LANE_FIELDS.repair;

/** "not given" is a complete answer — a caller who doesn't know has still answered. */
function isAnswered(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function newState(conversationId, callerNumber) {
  return {
    conversationId,
    callerNumber: callerNumber || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),

    // One address field, plus the postcode. That is what a Gas Safe engineer
    // needs to find a property and what the office would write down. A second
    // optional field only created somewhere for the address to land where it
    // didn't count, which loops the caller on a question they already answered.
    location: { addressLine1: null, postcode: null, inArea: null },

    // Which kind of call this is, and what they've actually got. Both are decided
    // before any lane questions, and both can end the call on their own.
    lane: null,                  // repair | service | newBoiler | existing | emergency
    systemType: null,            // what the caller says they have
    systemCovered: null,         // true | false | "unclear"
    callerRelationship: null,    // owner | tenant | landlord | agent

    diagnostics: {
      // repair lane
      issueType: null,
      fault: null,
      probeAnswer: null,
      makeModel: null,
      gcOrErrCode: null,
      symptoms: null,
      duration: null,
      previousWork: null,
      // service lane
      serviceType: null,         // service | certificate
      applianceCount: null,
      lastServiced: null,
      certificateExpiry: null,
      accessContact: null,
      // new boiler lane
      currentSystem: null,
      bedrooms: null,
      bathrooms: null,
      relocating: null,
      timescale: null,
    },

    emergency: null, // null | "gas" | "co" | "water" | "electrical"
    contact: { name: null, phone: null, email: null },

    offeredSlots: [], // ONLY slots Cal.com returned this call
    bookingUid: null,

    // Existing-customer flow: reschedule/cancel require a successful find first.
    foundBooking: null,

    isExistingCustomer: false,
    // How many times we have asked for each field and got nowhere. Nothing else
    // in this service has any memory of what has already been said, which is how
    // one unrecorded field became an unbounded loop.
    asked: {},
    stuck: null,
    outcome: null,
    events: [],
  };
}

/**
 * Gate A — we know where the property is, and it is ours to serve.
 *
 * Existing customers are exempt: they were gated when the visit was first booked,
 * and re-asking someone their own postcode to move an appointment is daft. The
 * exemption only applies once `find_booking` has matched a real booking.
 */
function gateA(state) {
  if (state.isExistingCustomer) return true;
  return (
    isAnswered(state.location.addressLine1) &&
    isAnswered(state.location.postcode) &&
    state.location.inArea === true
  );
}

/**
 * Gate B — this lane's own questions are answered.
 *
 * Existing customers are exempt; they were qualified when the visit was booked.
 * A system we don't cover never opens the gate, however complete the answers:
 * we decline before taking details rather than after.
 */
function gateB(state) {
  // The ONLY free pass, and it is earned server-side by a real find_booking match.
  if (state.isExistingCustomer) return true;

  // You cannot book a visit without knowing what the engineer is coming to.
  // `null` counts as not knowing — the check simply hasn't happened yet.
  if (state.systemCovered !== true) return false;

  if (!state.lane) return false;

  // `lane` is supplied by the model, and two lanes have no questions of their own:
  // "existing" (qualified when the visit was booked) and "emergency" (never books).
  // An empty field list means every() is vacuously true, so a model that labels an
  // air-conditioning caller "existing" would hand itself an open gate — which is
  // exactly what happened in testing. Those two lanes can never open Gate B here;
  // the existing-customer route goes through isExistingCustomer above.
  const fields = LANE_FIELDS[state.lane];
  if (!Array.isArray(fields) || fields.length === 0) return false;

  return fields.every((f) => isAnswered(state.diagnostics[f]));
}

/** What is still outstanding, in the order the call should ask for it. */
function missingFields(state) {
  const missing = [];
  if (state.isExistingCustomer) return missing; // already qualified and located

  // Order matters and is not negotiable: danger, then area, then what they own,
  // then who they are. Fault questions are gas-boiler questions — asking them of
  // someone with a storage heater tells the caller you aren't listening.
  if (!isAnswered(state.location.postcode)) missing.push('postcode');
  else if (state.location.inArea !== true) missing.push('areaCheck');
  if (!isAnswered(state.location.addressLine1)) missing.push('addressLine1');

  if (state.systemCovered === null) missing.push('systemType');
  else if (state.systemCovered !== true) missing.push('systemCheck');

  if (!isAnswered(state.callerRelationship)) missing.push('callerRelationship');
  if (!state.lane) missing.push('lane');
  else for (const f of LANE_FIELDS[state.lane] || []) {
    if (!isAnswered(state.diagnostics[f])) missing.push(f);
  }

  // Contact details, but only once times have been offered — the flow takes the
  // slot first and the details after, and asking someone's email before they
  // know if we can even come out is the wrong order.
  //
  // These were invisible here entirely, which is why next_question answered
  // "let's get you booked in" to a call with no name, no number and no email:
  // it sent her back to the diary while book_appointment refused for exactly
  // those fields. That round trip is the loop the client saw.
  if (state.offeredSlots && state.offeredSlots.length) {
    for (const f of CONTACT_FIELDS) {
      if (!isAnswered(state.contact[f])) missing.push(f);
    }
  }
  return missing;
}

/** Attach computed gates without ever storing them. */
function withGates(state) {
  return { ...state, gate: { A: gateA(state), B: gateB(state) } };
}

function sweep() {
  const now = Date.now();
  for (const [id, s] of store) {
    if (now - s.updatedAt > TTL_MS) store.delete(id);
  }
}

function get(conversationId, callerNumber) {
  sweep();
  if (!store.has(conversationId)) {
    store.set(conversationId, newState(conversationId, callerNumber));
  }
  const s = store.get(conversationId);
  if (callerNumber && !s.callerNumber) s.callerNumber = callerNumber;
  return s;
}

function touch(state, event) {
  state.updatedAt = Date.now();
  if (event) state.events.push({ at: new Date().toISOString(), ...event });
  return state;
}

function all() {
  return Array.from(store.values());
}

function reset() {
  store.clear();
}

module.exports = {
  get,
  touch,
  all,
  reset,
  gateA,
  gateB,
  missingFields,
  withGates,
  isAnswered,
  DIAGNOSTIC_FIELDS,
  LANE_FIELDS,
  LANES,
  CONTACT_FIELDS,
  noteAsked,
  MAX_ASKS,
  SOFT_FIELDS,
  HARD_BLOCKERS,
};
