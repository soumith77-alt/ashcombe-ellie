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
 * Never taken from a field the model fills — an LLM that invents a booking will
 * happily invent an id. Telnyx sends its own identifiers as headers; we look for
 * those first and only fall back to the body if none arrived.
 *
 * The first request of the process dumps every header, so the real header name is
 * confirmed from live traffic rather than assumed.
 */
const ID_HEADERS = [
  'x-telnyx-conversation-id',
  'telnyx-conversation-id',
  'x-telnyx-call-control-id',
  'telnyx-call-control-id',
  'x-telnyx-call-session-id',
];

let dumpedHeaders = false;

function conversationId(req) {
  if (!dumpedHeaders) {
    dumpedHeaders = true;
    console.log('[headers] first inbound tool call — full header set for id verification:');
    console.log(JSON.stringify(req.headers, null, 2));
    log.write({ type: 'first_headers', headers: req.headers });
  }
  for (const h of ID_HEADERS) {
    if (req.headers[h]) return String(req.headers[h]);
  }
  const b = req.body || {};
  return String(
    b.telnyx_conversation_id || b.conversation_id || b.conversationId || 'local-test'
  );
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

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Ellie middleware listening on :${PORT}`));
}

module.exports = app;
