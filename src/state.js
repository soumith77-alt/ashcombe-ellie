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

    // First line plus postcode is what a Gas Safe engineer needs to find a
    // property, and what the office would write down. Anything more is a
    // requirement we invented. addressExtra holds whatever the caller volunteers
    // — town, flat number — and is never asked for and never gates.
    location: { addressLine1: null, postcode: null, addressExtra: null, inArea: null },

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
};
