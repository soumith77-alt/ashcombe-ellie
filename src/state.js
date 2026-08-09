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

const DIAGNOSTIC_FIELDS = ['issueType', 'fault', 'makeModel', 'symptoms'];

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

    location: { address: null, postcode: null, inArea: null },

    diagnostics: {
      issueType: null,
      fault: null,
      probeAnswer: null,
      makeModel: null,
      gcOrErrCode: null,
      symptoms: null,
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
    isAnswered(state.location.address) &&
    isAnswered(state.location.postcode) &&
    state.location.inArea === true
  );
}

/** Gate B — all four diagnostics answered. Skipped for existing customers. */
function gateB(state) {
  if (state.isExistingCustomer) return true;
  return DIAGNOSTIC_FIELDS.every((f) => isAnswered(state.diagnostics[f]));
}

/** What is still outstanding, in the order the call should ask for it. */
function missingFields(state) {
  const missing = [];
  if (state.isExistingCustomer) return missing; // already diagnosed and located
  if (!isAnswered(state.location.postcode)) missing.push('postcode');
  else if (state.location.inArea !== true) missing.push('areaCheck');
  if (!isAnswered(state.location.address)) missing.push('address');

  if (!state.isExistingCustomer) {
    for (const f of DIAGNOSTIC_FIELDS) {
      if (!isAnswered(state.diagnostics[f])) missing.push(f);
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
};
