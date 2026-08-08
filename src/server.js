'use strict';

require('dotenv').config();
const express = require('express');
const state = require('./state');
const tools = require('./tools');
const log = require('./log');

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * Conversation key.
 *
 * Verified against live Telnyx traffic: a webhook tool call arrives with NO call
 * identifier. Headers carry only telnyx-signature-ed25519 and telnyx-timestamp;
 * the body carries only the parameters the model filled. Templated header values
 * are not resolved either — "{{call_control_id}}" arrives with braces intact.
 *
 * So the assistant carries the reference itself, read from {{call_control_id}} in
 * its instructions. Anything that looks like an unresolved template or an empty
 * value is rejected rather than used as a key.
 */
const ID_HEADERS = [
  'x-telnyx-conversation-id',
  'telnyx-conversation-id',
  'x-telnyx-call-control-id',
  'telnyx-call-control-id',
];

let dumpedHeaders = false;

function usable(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.includes('{{') || s.includes('}}')) return null; // unresolved template
  if (/^(null|undefined|none|n\/a)$/i.test(s)) return null;
  return s;
}

function conversationId(req) {
  if (!dumpedHeaders) {
    dumpedHeaders = true;
    console.log('[headers] first inbound tool call — headers and body, for id verification:');
    console.log(JSON.stringify({ headers: req.headers, body: req.body }, null, 2));
    log.write({ type: 'first_headers', headers: req.headers, body: req.body });
  }

  // Kept in case Telnyx starts sending one; costs nothing and beats the body.
  for (const h of ID_HEADERS) {
    const v = usable(req.headers[h]);
    if (v) return v;
  }

  const b = req.body || {};
  const ref = usable(b.conversationRef) || usable(b.conversation_id) || usable(b.conversationId);
  if (ref) return ref;

  // No reference available: web-chat testing, where {{call_control_id}} is empty.
  // Safe for one call at a time; concurrent voice calls always carry a real id.
  return 'no-ref';
}

function callerNumber(req) {
  const b = req.body || {};
  return b.telnyx_end_user_target || b.from || req.headers['x-telnyx-caller'] || null;
}

/** Wrap a handler so every tool gets state, timing, and logging for free. */
function tool(name, handler) {
  return async (req, res) => {
    const started = Date.now();
    const s = state.get(conversationId(req), callerNumber(req));
    try {
      const result = await handler(s, req.body || {});
      const ms = Date.now() - started;
      log.write({
        type: 'tool',
        tool: name,
        conversationId: s.conversationId,
        ms,
        ok: result.ok,
        reason: result.reason || result.blocked || null,
      });
      if (ms > 2000) console.warn(`[slow] ${name} took ${ms}ms`);
      res.json(result);
    } catch (err) {
      console.error(`[error] ${name}:`, err);
      log.write({ type: 'tool_error', tool: name, conversationId: s.conversationId, error: String(err && err.message) });
      // Never leak a stack trace into something a caller will hear.
      res.json({
        ok: false,
        reason: 'error',
        say: "I'm having a bit of trouble here — could you give the office a ring and they'll sort you out? Sorry about that.",
      });
    }
  };
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/tools/service-area', tool('check_service_area', tools.checkServiceArea));
app.post('/tools/next-question', tool('next_question', tools.nextQuestionTool));
app.post('/tools/record', tool('record_details', tools.recordDetails));
app.post('/tools/availability', tool('check_availability', tools.checkAvailability));
app.post('/tools/book', tool('book_appointment', tools.bookAppointment));
app.post('/tools/emergency', tool('flag_emergency', tools.flagEmergency));
app.post('/tools/find', tool('find_booking', tools.findBooking));
app.post('/tools/confirm-name', tool('confirm_name', tools.confirmName));
app.post('/tools/reschedule', tool('reschedule_booking', tools.rescheduleBooking));
app.post('/tools/cancel', tool('cancel_booking', tools.cancelBooking));

/** Cal.com webhooks — keeps our view true when the office edits the diary by hand. */
app.post('/webhooks/calcom', (req, res) => {
  const ev = req.body || {};
  log.write({ type: 'calcom_webhook', trigger: ev.triggerEvent, uid: ev.payload && ev.payload.uid });
  res.json({ ok: true });
});

/** Post-call summary from Telnyx Insights. */
app.post('/webhooks/telnyx-insights', (req, res) => {
  log.write({ type: 'insights', payload: req.body });
  res.json({ ok: true });
});

/** "How many callers did we turn away as out of area?" — the month-two question. */
app.get('/report', (_req, res) => res.json(log.summary()));

/** Inspect a call's state — used by the scenario tests to assert on real state. */
app.get('/state/:id', (req, res) => {
  const s = state.all().find((x) => x.conversationId === req.params.id);
  if (!s) return res.status(404).json({ ok: false });
  res.json(state.withGates(s));
});

/**
 * Test-only. Web chat has no {{call_control_id}}, so every chat conversation keys
 * to "no-ref" and would otherwise inherit the previous scenario's answers.
 * Refuses unless explicitly enabled, so it can't be hit in production.
 */
app.post('/test/reset', (req, res) => {
  if (process.env.ALLOW_TEST_RESET !== 'true') return res.status(403).json({ ok: false });
  state.reset();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Ellie middleware listening on :${PORT}`));
}

module.exports = app;
