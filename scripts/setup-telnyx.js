'use strict';

/**
 * Creates the shared webhook tools and the assistant.
 *
 * Inline `tools` on an assistant is deprecated ("Prefer tool_ids to attach shared
 * tools created with the AI Tools endpoints"), so tools are created once via
 * /ai/tools and attached by id.
 *
 * There is no filler-message feature in the Telnyx API — verified against the full
 * OpenAPI spec. Silence is handled instead by a hard latency budget, a background
 * audio bed, and the prompt speaking its line before the tool call. `timeout_ms`
 * caps at 10000, so the brief's "30s" is not expressible.
 *
 * Safe to re-run: existing tools and the assistant are updated in place.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API = 'https://api.telnyx.com/v2';
const KEY = process.env.TELNYX_API_KEY;
const BASE = process.env.PUBLIC_BASE_URL;

if (!KEY) throw new Error('TELNYX_API_KEY not set');
if (!BASE) throw new Error('PUBLIC_BASE_URL not set — start the tunnel first');

const MODEL = process.env.TELNYX_MODEL || 'openai/gpt-5.4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Telnyx returns the odd transient 503 on writes; retry rather than half-configure. */
async function api(pathname, { method = 'GET', body, attempts = 4 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
    last = { ok: res.ok, status: res.status, json };
    if (res.ok || res.status < 500) return last;
    await sleep(800 * (i + 1));
  }
  return last;
}

const str = (description) => ({ type: 'string', description });

/**
 * Tool names here MUST match the names used in docs/instructions.md exactly.
 * A tool named one thing in the config and another in the prompt silently breaks
 * invocation, so scripts/check-names.js diffs the two.
 */
const TOOLS = [
  {
    name: 'check_service_area',
    description:
      "Check whether a postcode is inside the company's service area. Call this as soon as the caller gives a postcode, before taking any other details. Returns inArea true, false, or unclear.",
    url: `${BASE}/tools/service-area`,
    timeout_ms: 3000,
    body: {
      type: 'object',
      properties: {
        postcode: str('The postcode exactly as the caller said it, e.g. "M20 2RT".'),
        town: str('The town or area name, if the caller gave one.'),
      },
      required: ['postcode'],
    },
  },
  {
    name: 'next_question',
    description:
      "Ask what still needs to be captured and what to say next. Call this whenever you lose your place — especially straight after answering a question about the business — so you return to the right point instead of drifting to booking.",
    url: `${BASE}/tools/next-question`,
    timeout_ms: 2000,
    body: { type: 'object', properties: {} },
  },
  {
    name: 'record_details',
    description:
      "Save what the caller has told you. Call this as details arrive, not all at the end. Pass only the fields you actually heard. Use the literal string 'not given' when the caller says they don't know.",
    url: `${BASE}/tools/record`,
    timeout_ms: 3000,
    body: {
      type: 'object',
      properties: {
        address: str('Full address: house number and street, plus town.'),
        postcode: str('Postcode.'),
        issueType: str("One of: repair, service, install, landlord_cert."),
        fault: str("What the boiler is actually doing, in the caller's own words."),
        probeAnswer: str('The answer to your one follow-up probe about the fault.'),
        makeModel: str("Boiler make and model, or 'not given'."),
        gcOrErrCode: str("Error code on the display or GC number, or 'not given'."),
        symptoms: str("Other visible symptoms: water, warning lights, pilot light, or 'not given'."),
        name: str("Caller's full name."),
        phone: str('Best contact number.'),
        email: str('Email address for the confirmation.'),
      },
    },
  },
  {
    name: 'check_availability',
    description:
      'Look at the engineers\' diary and get real appointment times. Say "Let me have a look at the diary" before calling this. Only offer times this returns — never invent one. Refuses until the address, postcode and all four fault questions are done.',
    url: `${BASE}/tools/availability`,
    timeout_ms: 9000,
    body: {
      type: 'object',
      properties: {
        dayPreference: str('The day the caller asked for, e.g. "Wednesday", "tomorrow", "the 12th".'),
        timePreference: str('"morning", "afternoon", or "any". Optional — use "any" if the caller only gave a day. Never ask a separate question just to fill this in.'),
      },
      required: ['dayPreference'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book the visit. Say "Right, let me get that booked in for you" before calling. Pass the chosen time exactly as you offered it. WAIT for this to return before telling the caller anything is booked.',
    url: `${BASE}/tools/book`,
    timeout_ms: 10000,
    body: {
      type: 'object',
      properties: {
        chosenSlotLabel: str('The time the caller picked, worded exactly as check_availability returned it.'),
      },
      required: ['chosenSlotLabel'],
    },
  },
  {
    name: 'flag_emergency',
    description:
      'Record that this call is a safety emergency. Call this the moment a caller mentions a gas smell, a CO alarm, feeling unwell, water pouring, sparking or burning. After this, no booking is possible on this call.',
    url: `${BASE}/tools/emergency`,
    timeout_ms: 2000,
    body: {
      type: 'object',
      properties: { kind: str('One of: gas, co, water, electrical.') },
      required: ['kind'],
    },
  },
  {
    name: 'find_booking',
    description:
      "Find an existing booking by phone number. Returns the date and time only — never the name. Use this when a caller wants to move or cancel a visit.",
    url: `${BASE}/tools/find`,
    timeout_ms: 9000,
    body: {
      type: 'object',
      properties: { phone: str("The number the booking was made under. Defaults to the number they're calling from.") },
    },
  },
  {
    name: 'confirm_name',
    description:
      "Check the name the caller gives against the booking. Call this after find_booking. If it doesn't match, never say the name on the booking.",
    url: `${BASE}/tools/confirm-name`,
    timeout_ms: 2000,
    body: {
      type: 'object',
      properties: { name: str('The name the caller gave.') },
      required: ['name'],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      'Move an existing booking to a new time. Requires a successful find_booking and confirm_name first, and the new time must be one check_availability returned.',
    url: `${BASE}/tools/reschedule`,
    timeout_ms: 10000,
    body: {
      type: 'object',
      properties: { chosenSlotLabel: str('The new time, worded exactly as it was offered.') },
      required: ['chosenSlotLabel'],
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel an existing booking. Requires a successful find_booking and confirm_name first.',
    url: `${BASE}/tools/cancel`,
    timeout_ms: 10000,
    body: { type: 'object', properties: {} },
  },
];

/**
 * How this call is identified — verified the hard way against live traffic.
 *
 * Telnyx sends NO call identifier on a webhook tool call. The headers carry only
 * telnyx-signature-ed25519 and telnyx-timestamp; the body carries only the
 * parameters the model filled in. Templated headers do NOT resolve either — a
 * header value of "{{call_control_id}}" arrives with the braces intact.
 *
 * That leaves one route: the assistant carries the reference itself, read from
 * {{call_control_id}} which Telnyx injects into the instructions. So it is added
 * to every tool as `conversationRef`.
 *
 * This is the one place the brief's "never trust the model with an ID" rule can't
 * be fully honoured — the platform gives no alternative. The failure mode is made
 * safe rather than eliminated: if the reference is garbled, the state splits, the
 * gates never close, and the middleware REFUSES to book. A confused caller, never
 * a phantom engineer visit.
 */
const CONVERSATION_REF = {
  conversationRef: str('The reference for this call, copied exactly from your instructions.'),
};

function toolPayload(t) {
  const body = {
    ...t.body,
    properties: { ...(t.body.properties || {}), ...CONVERSATION_REF },
  };
  return {
    type: 'webhook',
    display_name: t.name,
    timeout_ms: t.timeout_ms,
    webhook: {
      name: t.name,
      description: t.description,
      url: t.url,
      method: 'POST',
      timeout_ms: t.timeout_ms,
      body_parameters: body,
    },
  };
}

async function ensureTools() {
  const list = await api('/ai/tools');
  const existing = list.ok && Array.isArray(list.json.data) ? list.json.data : [];
  const ids = [];

  for (const t of TOOLS) {
    const found = existing.find(
      (e) => e.display_name === t.name || (e.webhook && e.webhook.name === t.name)
    );
    if (found) {
      const upd = await api(`/ai/tools/${found.id}`, { method: 'PATCH', body: toolPayload(t) });
      console.log(`  ${upd.ok ? 'updated' : 'UPDATE FAILED'} ${t.name} -> ${found.id}${upd.ok ? '' : ' ' + JSON.stringify(upd.json).slice(0, 200)}`);
      ids.push(found.id);
      continue;
    }
    const r = await api('/ai/tools', { method: 'POST', body: toolPayload(t) });
    if (!r.ok) {
      console.error(`  FAILED to create ${t.name}:`, r.status, JSON.stringify(r.json).slice(0, 400));
      process.exit(1);
    }
    const id = r.json.data ? r.json.data.id : r.json.id;
    console.log(`  created ${t.name} -> ${id}`);
    ids.push(id);
  }
  return ids;
}

function assistantPayload(toolIds) {
  const instructions = fs.readFileSync(path.join(__dirname, '..', 'docs', 'instructions.md'), 'utf8');
  return {
    name: 'Ellie — Ashcombe Heating',
    model: MODEL,
    instructions,
    tool_ids: toolIds,
    greeting: "Good morning, Ashcombe Heating, Ellie speaking — how can I help?",
    description: 'Phone receptionist: qualifies heating callers and books engineer visits.',
    voice_settings: {
      // en-GB, Telnyx-hosted so no third-party key is needed.
      voice: 'Telnyx.Ultra.fb02b554-7d64-4f90-841e-e57fc88f410c', // Ailsa — Warm Guide
      voice_speed: 1.0,
      // No filler-message feature exists in the API; a quiet office bed keeps a
      // 1-2s tool pause from reading as a dropped call.
      background_audio: { type: 'predefined_media', value: 'office', volume: 0.3 },
    },
    transcription: { model: 'deepgram/flux', language: 'en' },
    telephony_settings: {
      user_idle_reply_secs: 12,
      user_idle_timeout_secs: 45,
      time_limit_secs: 900,
      // Lets you actually talk to Ellie from a browser while there's no phone
      // number on the account — real voice, real STT, real barge-in.
      supports_unauthenticated_web_calls: true,
    },
    widget_settings: {
      start_call_text: 'Call Ashcombe Heating',
      agent_thinking_text: 'One moment…',
      speak_to_interrupt_text: 'Speak to interrupt',
    },
    enabled_features: ['telephony'],
  };
}

function writeEnv(kv) {
  const p = path.join(__dirname, '..', '.env');
  let text = fs.readFileSync(p, 'utf8');
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}\n${k}=${v}`;
  }
  fs.writeFileSync(p, text);
}

(async () => {
  console.log(`Telnyx setup  (model=${MODEL}, base=${BASE})`);
  const toolIds = await ensureTools();

  const payload = assistantPayload(toolIds);
  const existingId = process.env.TELNYX_ASSISTANT_ID;

  if (existingId) {
    const r = await api(`/ai/assistants/${existingId}`, { method: 'POST', body: payload });
    if (!r.ok) {
      console.error('  assistant update failed:', r.status, JSON.stringify(r.json).slice(0, 600));
      process.exit(1);
    }
    console.log(`  updated assistant -> ${existingId}`);
    return;
  }

  const r = await api('/ai/assistants', { method: 'POST', body: payload });
  if (!r.ok) {
    console.error('  assistant create failed:', r.status, JSON.stringify(r.json).slice(0, 800));
    process.exit(1);
  }
  const id = r.json.id || (r.json.data && r.json.data.id);
  console.log(`  created assistant -> ${id}`);
  writeEnv({ TELNYX_ASSISTANT_ID: id });
})();
