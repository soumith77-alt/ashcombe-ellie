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

  // Historical totals come from the log, not from memory — in-memory state is swept
  // after two hours and lost on restart, and "how many did we turn away last month"
  // is the question that actually gets asked.
  const entries = read();
  const area = entries.filter((e) => e.type === 'area_result');
  const outcomes = entries.filter((e) => e.type === 'outcome');
  const tools = entries.filter((e) => e.type === 'tool');

  const uniq = (list, key) => new Set(list.map((e) => e[key]).filter(Boolean)).size;
  const slowest = tools.reduce((m, e) => Math.max(m, e.ms || 0), 0);

  return {
    since: entries.length ? entries[0].at : null,

    allTime: {
      callsSeen: uniq(entries, 'conversationId'),
      inArea: area.filter((e) => e.inArea === true).length,
      turnedAwayOutOfArea: area.filter((e) => e.inArea === false).length,
      unclearArea: area.filter((e) => e.inArea === 'unclear').length,
      booked: outcomes.filter((e) => e.outcome === 'booked').length,
      emergencies: outcomes.filter((e) => e.outcome === 'emergency').length,
      toolCalls: tools.length,
      toolFailures: tools.filter((e) => e.ok === false).length,
      slowestToolMs: slowest,
    },

    live: {
      activeCalls: calls.length,
      bothGatesClosed: calls.filter((c) => c.gateA && c.gateB).length,
      calls,
    },
  };
}

module.exports = { write, read, summary, FILE };
