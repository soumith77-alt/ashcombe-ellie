'use strict';

const fs = require('fs');
const path = require('path');
const state = require('./state');

/**
 * Append-only JSONL. Queryable is the point: "how many callers did we turn away
 * as out of area" is a question the client will ask in month two, and it should be
 * answerable without reading transcripts.
 */

const DIR = path.join(__dirname, '..', 'logs');
const FILE = path.join(DIR, 'calls.jsonl');

function write(entry) {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    console.error('[log] write failed:', err.message);
  }
}

function read() {
  if (!fs.existsSync(FILE)) return [];
  return fs
    .readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

/** Per-call outcome, derived from live state plus the log. */
function summary() {
  const calls = state.all().map((s) => ({
    conversationId: s.conversationId,
    outcome: s.outcome || 'incomplete',
    gateA: state.gateA(s),
    gateB: state.gateB(s),
    inArea: s.location.inArea,
    emergency: s.emergency,
    booked: Boolean(s.bookingUid),
    captured: {
      postcode: s.location.postcode,
      address: s.location.address,
      issueType: s.diagnostics.issueType,
      fault: s.diagnostics.fault,
      makeModel: s.diagnostics.makeModel,
      symptoms: s.diagnostics.symptoms,
    },
  }));

  const entries = read();
  const counts = entries.reduce((acc, e) => {
    if (e.type === 'tool') acc.toolCalls = (acc.toolCalls || 0) + 1;
    if (e.type === 'booked') acc.booked = (acc.booked || 0) + 1;
    return acc;
  }, {});

  return {
    activeCalls: calls.length,
    outOfArea: calls.filter((c) => c.inArea === false).length,
    unclearArea: calls.filter((c) => c.inArea === 'unclear').length,
    emergencies: calls.filter((c) => c.emergency).length,
    booked: calls.filter((c) => c.booked).length,
    bothGatesClosed: calls.filter((c) => c.gateA && c.gateB).length,
    logCounts: counts,
    calls,
  };
}

module.exports = { write, read, summary, FILE };
