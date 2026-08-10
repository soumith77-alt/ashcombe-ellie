'use strict';

/**
 * The six webhook tools.
 *
 * Every handler takes (state, body) and returns a plain object. No Express types
 * in here, so the tests can drive them directly without a server.
 *
 * The refusals below are the whole point of this service. The assistant's prompt
 * says the same things, but a prompt gets skipped under pressure and this does not.
 */

const state = require('../state');
const postcode = require('../postcode');
const time = require('../time');
const cal = require('../calcom');
const jobDescription = require('../jobDescription');
const systemType = require('../systemType');
const auditLog = require('../log');
const sheets = require('../sheets');
const email = require('../email');
const { nextQuestion, probeFor } = require('../questions');
const business = require('../../config/business.json');

const OFFICE = business.officePhone;

/* ------------------------------------------------------------------ helpers */

function gates(s) {
  return { gateA: state.gateA(s), gateB: state.gateB(s) };
}

/** Refuse if anything about this call means booking must not happen. */
function bookingBlocked(s) {
  if (s.emergency) {
    return {
      ok: false,
      reason: 'emergency',
      say: `I can't book a visit while there's a safety issue at the property. Once it's been made safe, ring the office on ${OFFICE} and we'll get someone out.`,
    };
  }
  const { gateA, gateB } = gates(s);
  if (!gateA || !gateB) {
    const next = nextQuestion(s);
    return {
      ok: false,
      blocked: 'gate',
      reason: 'gate',
      gateA,
      gateB,
      missing: next.missing,
      say: next.say,
    };
  }
  return null;
}

/* ----------------------------------------------------- 1. check_service_area */

function checkServiceArea(s, body) {
  const result = postcode.check(body.postcode, body.town);

  if (result.reask) {
    return { ok: true, inArea: 'unclear', reask: true, say: result.say };
  }

  s.location.postcode = result.outward
    ? String(body.postcode || '').toUpperCase().trim()
    : s.location.postcode;
  s.location.inArea = result.inArea;
  state.touch(s, { type: 'service_area', outward: result.outward, inArea: result.inArea });
  // Durable, so "how many did we turn away as out of area" survives a restart.
  auditLog.write({
    type: 'area_result',
    conversationId: s.conversationId,
    outward: result.outward,
    inArea: result.inArea,
  });

  if (result.inArea === true) {
    const next = nextQuestion(s);
    return { ok: true, inArea: true, say: `${result.say} ${next.say}`.trim() };
  }
  // The month-two question: how many callers did we turn away, and from where.
  s.outcome = result.inArea === false ? 'out_of_area' : 'area_unclear';
  sheets.logCall(s, s.outcome, `postcode ${result.outward || 'not heard'}`);
  return { ok: true, inArea: result.inArea, say: result.say };
}

/* ------------------------------------------------------- 1b. check_system_type */

function checkSystemType(s, body) {
  const r = systemType.check(body.systemDescription || body.systemType);

  if (r.covered !== 'unclear' || body.systemDescription) {
    s.systemType = String(body.systemDescription || body.systemType || '').trim() || s.systemType;
  }
  s.systemCovered = r.covered;
  state.touch(s, { type: 'system_type', matched: r.matched, covered: r.covered });
  auditLog.write({
    type: 'system_result',
    conversationId: s.conversationId,
    systemType: s.systemType,
    covered: r.covered,
  });

  if (r.covered === true) {
    // Carry a volunteered brand straight into the make, so the repair lane never
    // asks for something the caller has already told us.
    if (r.make && !state.isAnswered(s.diagnostics.makeModel)) {
      s.diagnostics.makeModel = String(body.systemDescription || '').trim();
    }
    const next = nextQuestion(s);
    return { ok: true, covered: true, say: next.say };
  }

  // Declined or unclear: this call will not reach the diary, so record why now.
  s.outcome = r.covered === false ? 'system_not_covered' : 'system_unclear';
  sheets.logCall(s, s.outcome, `system: ${s.systemType || 'not given'}`);
  return { ok: true, covered: r.covered, say: r.say };
}

/* -------------------------------------------------------- 2. next_question */

function nextQuestionTool(s) {
  // Asking "what next?" repeatedly and getting the same answer means the caller
  // isn't going to give it. Count it, so the third time we do something else.
  state.nextTurn(s);
  const before = state.missingFields(s)[0];
  state.noteAsked(s, before);
  const { gateA, gateB } = gates(s);
  const next = nextQuestion(s);
  return { ok: true, missing: next.missing, gateA, gateB, stuck: s.stuck || undefined, say: next.say };
}

/* -------------------------------------------------------- 3. record_details */

const DIAG_KEYS = [
  'issueType', 'fault', 'probeAnswer', 'makeModel', 'gcOrErrCode', 'symptoms',
  'duration', 'previousWork',
  'serviceType', 'applianceCount', 'lastServiced', 'certificateExpiry', 'accessContact',
  'currentSystem', 'bedrooms', 'bathrooms', 'relocating', 'timescale',
];
// The name has its own handling below; these two are plain copies.
const CONTACT_KEYS = ['phone', 'email'];
const TOP_KEYS = ['lane', 'callerRelationship', 'systemType'];

/**
 * The name, however it arrives.
 *
 * It is asked as two questions now, but a caller who says "James Whitfield" to the
 * first one gives both at once, and an older tool config may still send `name`.
 * Whichever door it comes through, first and last end up where the gate looks —
 * the same lesson as the address field.
 */
function applyName(s, body) {
  for (const k of ['firstName', 'surname']) {
    if (state.isAnswered(body[k])) s.contact[k] = String(body[k]).trim();
  }

  if (state.isAnswered(body.name)) {
    const parts = String(body.name).trim().split(/\s+/);
    if (!state.isAnswered(s.contact.firstName)) s.contact.firstName = parts[0];
    if (parts.length > 1 && !state.isAnswered(s.contact.surname)) {
      s.contact.surname = parts.slice(1).join(' ');
    }
  }

  // A first name volunteered with a surname attached ("James Whitfield" to "can I
  // take your first name?") is two answers, not one. Split it rather than asking
  // for a surname they have already given.
  const first = s.contact.firstName;
  if (state.isAnswered(first) && /\s/.test(String(first).trim())) {
    const parts = String(first).trim().split(/\s+/);
    s.contact.firstName = parts[0];
    if (!state.isAnswered(s.contact.surname)) s.contact.surname = parts.slice(1).join(' ');
  }

  s.contact.name = state.fullName(s);
}

function recordDetails(s, body) {
  // A new caller turn. Everything outstanding may be counted once more.
  state.nextTurn(s);
  const outstandingBefore = state.missingFields(s)[0];

  // There is ONE address field, and every name the model might reach for funnels
  // into it. Whatever the caller said about where they live is the address —
  // which key it arrived under is our problem, not theirs.
  const line1 = [body.addressLine1, body.address, body.addressExtra]
    .find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  if (line1 !== undefined) s.location.addressLine1 = String(line1).trim();
  for (const k of TOP_KEYS) {
    if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') {
      s[k] = String(body[k]).trim();
    }
  }

  // The system answer can arrive through this tool OR through system_type, and
  // only one of them used to set the verdict the gate reads. That left the text
  // recorded, the check never run, and next_question asking "what have you got?"
  // on every single turn — the loop the client hit. Either door now turns the
  // same lock.
  if (body.systemType !== undefined && body.systemType !== null && String(body.systemType).trim() !== '') {
    const r = systemType.check(body.systemType);
    s.systemCovered = r.covered;
    if (r.make && !state.isAnswered(s.diagnostics.makeModel)) {
      s.diagnostics.makeModel = String(body.systemType).trim();
    }
  }

  if (body.postcode !== undefined && body.postcode !== null && String(body.postcode).trim() !== '') {
    const r = postcode.check(body.postcode);
    if (!r.reask) {
      s.location.postcode = String(body.postcode).toUpperCase().trim();
      s.location.inArea = r.inArea;
    }
  }

  for (const k of DIAG_KEYS) {
    if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') {
      s.diagnostics[k] = String(body[k]).trim();
    }
  }
  for (const k of CONTACT_KEYS) {
    if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') {
      s.contact[k] = String(body[k]).trim();
    }
  }
  applyName(s, body);

  if (body.emergency) s.emergency = String(body.emergency).trim();

  state.touch(s, { type: 'record', fields: Object.keys(body || {}) });

  // The field we gave up on has arrived. Let the call carry on rather than
  // repeating the office handoff at someone who is answering the question.
  state.unstick(s);

  // Nothing moved: the same question is outstanding as before this call, so the
  // caller has now been asked and hasn't answered. That is the signal the old
  // code had no way to notice, and why one unset field looped forever.
  const after = state.missingFields(s)[0];
  if (after && after === outstandingBefore) state.noteAsked(s, after);

  const { gateA, gateB } = gates(s);
  const next = nextQuestion(s);
  return { ok: true, gateA, gateB, missing: next.missing, stuck: s.stuck || undefined, say: next.say };
}

/* ----------------------------------------------------- 4. check_availability */

async function checkAvailability(s, body) {
  const blocked = bookingBlocked(s);
  if (blocked) return blocked; // Cal.com is never touched.

  const day = time.resolveDay(body.dayPreference);
  if (!day) {
    return {
      ok: true,
      slots: [],
      say: 'What day were you thinking? I can look from tomorrow onwards.',
    };
  }

  const pref = time.resolveTimePreference(body.timePreference);
  const start = day;
  const end = time.ymd(time.addDays(new Date(`${day}T12:00:00Z`), 7));

  const r = await cal.getSlots({
    eventTypeId: eventTypeForLane(s.lane),
    start,
    end,
  });
  if (!r.ok) {
    return {
      ok: false,
      reason: 'lookup_failed',
      say: `I'm having a bit of trouble with the diary just now — could you give the office a ring on ${OFFICE}? Sorry about that.`,
    };
  }

  const now = Date.now();
  const usable = r.slots
    .map((iso) => ({ iso, d: new Date(iso) }))
    .filter((x) => x.d.getTime() > now)
    .filter((x) => time.withinBookingHours(x.d));

  const onRequestedDay = usable.filter((x) => time.ymd(x.d) === day);
  const preferred = onRequestedDay.filter((x) => time.matchesTimePreference(x.d, pref));

  // Prefer the day and half-day asked for; widen only as far as needed so the
  // caller always hears concrete options rather than another question.
  let chosen = preferred.length ? preferred : onRequestedDay;
  let widened = false;
  if (!chosen.length) {
    chosen = usable.filter((x) => time.matchesTimePreference(x.d, pref));
    if (!chosen.length) chosen = usable;
    widened = true;
  }

  const picked = chosen.slice(0, business.maxSlotsOffered);
  if (!picked.length) {
    return {
      ok: true,
      slots: [],
      say: "I've nothing free in the next week or so by the look of it. Is there another week that'd suit?",
    };
  }

  s.offeredSlots = picked.map((x) => ({ label: time.spokenLabel(x.iso), startIso: x.iso }));
  state.touch(s, { type: 'availability', offered: s.offeredSlots.map((x) => x.label) });

  const labels = s.offeredSlots.map((x) => x.label);
  const spoken =
    labels.length === 1
      ? `I can do ${labels[0]}.`
      : `I can do ${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}.`;

  return {
    ok: true,
    slots: s.offeredSlots.map((x) => ({ label: x.label })), // ISO never leaves the server
    widened,
    say: `${spoken} Any of those any good?`,
  };
}

/* ------------------------------------------------------- 5. book_appointment */

function findOfferedSlot(s, chosenSlotLabel) {
  const wanted = String(chosenSlotLabel || '').toLowerCase().trim();
  if (!wanted) return null;
  const exact = s.offeredSlots.find((x) => x.label.toLowerCase() === wanted);
  if (exact) return exact;
  // Tolerate the assistant paraphrasing its own offer ("Wednesday at 9am").
  return s.offeredSlots.find((x) => {
    const l = x.label.toLowerCase();
    const time_ = l.split(' at ')[1];
    const weekday = l.split(' ')[0];
    return time_ && wanted.includes(time_) && wanted.includes(weekday);
  }) || null;
}

/**
 * A survey is a sales visit, a service is shorter than a repair, and the office
 * needs to see the difference in the diary. Falls back to the repair type when a
 * lane-specific one isn't configured, so a missing env var can't stop a booking.
 */
function eventTypeForLane(lane) {
  const repair = process.env.CALCOM_EVENT_TYPE_ID;
  if (lane === 'service') return process.env.CALCOM_EVENT_TYPE_SERVICE || repair;
  if (lane === 'newBoiler') return process.env.CALCOM_EVENT_TYPE_SURVEY || repair;
  return repair;
}

/**
 * A booking that didn't happen is worth more to the office than one that did.
 *
 * The success path wrote a sheet row, an audit entry and two emails. The failure
 * path wrote one in-memory event that is swept after two hours and lost on every
 * restart — and the local JSONL it might have reached lives on Railway's ephemeral
 * disk, so it doesn't survive a deploy either. A caller who wanted a Wednesday
 * morning and got "ring the office" instead vanished completely: no name, no
 * number, nobody to ring them back. Every one of those was a lost customer nobody
 * could even count.
 *
 * Logged once per call — the model retries, the office shouldn't get three rows.
 */
function recordLostBooking(s, reason, wantedLabel) {
  if (s.lossLogged) return;
  s.lossLogged = true;
  s.outcome = 'booking_failed';

  state.touch(s, { type: 'booking_lost', reason, wanted: wantedLabel || null });
  auditLog.write({
    type: 'outcome',
    outcome: 'booking_failed',
    conversationId: s.conversationId,
    reason,
    wanted: wantedLabel || null,
    postcode: s.location.postcode,
  });
  // Into the Bookings tab, not the call log — this needs a human to ring back, and
  // the office watches that tab. The status column says so in words.
  sheets.logBooking(s, wantedLabel || 'no time held', jobDescription.build(s), 'NEEDS CALLBACK');
  email.sendBookingFailed(s, wantedLabel, reason);
}

async function bookAppointment(s, body) {
  const blocked = bookingBlocked(s);
  if (blocked) return blocked;

  const missingContact = state.ALL_CONTACT_FIELDS.filter((k) => !state.isAnswered(s.contact[k]));
  if (missingContact.length) {
    // Count the refusal. Without this, book_appointment asks for the same detail
    // forever: it is the only thing that checks contact fields, so nothing else
    // could ever notice the caller had already been asked. noteAsked counts once
    // per caller turn, so the model retrying this call costs the caller nothing.
    const decision = state.noteAsked(s, missingContact[0]);
    if (decision === 'stop') recordLostBooking(s, `gave up on ${missingContact[0]}`);
    const next = nextQuestion(s);
    return {
      ok: false,
      reason: decision === 'stop' ? 'stuck' : 'missing_field',
      missing: missingContact,
      stuck: s.stuck || undefined,
      say: next.say,
    };
  }

  if (!state.isAnswered(body.chosenSlotLabel)) {
    return {
      ok: false,
      reason: 'missing_field',
      missing: ['chosenSlotLabel'],
      say: 'Which of those times would suit you best?',
    };
  }

  // THE LOCK: a time we never offered cannot be booked, however confidently it was said.
  const slot = findOfferedSlot(s, body.chosenSlotLabel);
  if (!slot) {
    const labels = s.offeredSlots.map((x) => x.label);
    return {
      ok: false,
      reason: 'slot_not_offered',
      offered: labels,
      say: labels.length
        ? `Let me just check — I've got ${labels.join(', or ')}. Which of those would you like?`
        : "Let me have another look at the diary and find you a time.",
    };
  }

  // Re-check the slot is still free: availability and booking are separate calls
  // and the office can fill it in between.
  const fresh = await cal.getSlots({
    eventTypeId: eventTypeForLane(s.lane),
    start: time.ymd(new Date(slot.startIso)),
    end: time.ymd(time.addDays(new Date(slot.startIso), 1)),
  });
  const stillFree = fresh.ok && fresh.slots.some((iso) => new Date(iso).getTime() === new Date(slot.startIso).getTime());
  if (!stillFree) {
    s.offeredSlots = s.offeredSlots.filter((x) => x.startIso !== slot.startIso);
    return {
      ok: false,
      reason: 'slot_gone',
      say: `Ah — someone's just taken that one, sorry. Shall I find you another time?`,
    };
  }

  const r = await cal.createBooking({
    eventTypeId: eventTypeForLane(s.lane),
    startIso: slot.startIso,
    name: s.contact.name,
    email: s.contact.email,
    phone: s.contact.phone,
    description: jobDescription.build(s),
    metadata: { source: 'phone', conversationId: String(s.conversationId).slice(0, 40) },
  });

  if (!r.ok) {
    state.touch(s, { type: 'book_failed', status: r.status, body: JSON.stringify(r.json).slice(0, 300) });
    recordLostBooking(s, `Cal.com refused the booking (${r.status})`, slot.label);
    return {
      ok: false,
      reason: 'booking_failed',
      say: `I'm having a bit of trouble getting that to save just now — could you give the office a ring on ${OFFICE} and they'll get it in the diary for you? Sorry about that.`,
    };
  }

  s.bookingUid = r.json && r.json.data ? r.json.data.uid : null;
  s.outcome = 'booked';
  state.touch(s, { type: 'booked', uid: s.bookingUid, label: slot.label });
  auditLog.write({
    type: 'outcome',
    outcome: 'booked',
    conversationId: s.conversationId,
    uid: s.bookingUid,
    label: slot.label,
    postcode: s.location.postcode,
  });
  // Fire and forget — a slow spreadsheet must never hold up a caller.
  sheets.logBooking(s, slot.label, jobDescription.build(s));
  // An earlier attempt on this call failed and raised a callback. It's booked now,
  // so close that row rather than having the office ring someone already in the diary.
  if (s.lossLogged) sheets.resolveLoss(s.conversationId);
  // The confirmation Ellie just promised the caller.
  email.sendBooked(s, slot.label);

  return {
    ok: true,
    say: `Lovely, you're all booked in for ${slot.label}. You'll get a confirmation email through in the next few minutes, and the office will give you a ring to confirm the engineer and the arrival window.`,
  };
}

/* ------------------------------------------- 6. find / reschedule / cancel */

function digitsOf(v) {
  return String(v || '').replace(/\D/g, '').replace(/^44/, '0');
}

async function findBooking(s, body) {
  const phone = digitsOf(body.phone || s.callerNumber);
  if (!phone) {
    return { ok: true, found: false, say: "What's the best number the booking would've been made under?" };
  }

  const r = await cal.getBookings({ status: 'upcoming', take: '50' });
  if (!r.ok) {
    return { ok: false, say: `I can't pull the diary up just now — could you ring the office on ${OFFICE}?` };
  }

  const rows = Array.isArray(r.json.data) ? r.json.data : (r.json.data && r.json.data.bookings) || [];
  const match = rows.find((b) => {
    const hay = JSON.stringify(b.attendees || b.attendee || {});
    return digitsOf(hay).includes(phone.slice(-9)) || (b.metadata && digitsOf(b.metadata.phone).includes(phone.slice(-9)));
  });

  if (!match) {
    return { ok: true, found: false, say: "I can't find a booking under that number, I'm afraid. Shall I take some details and get you booked in?" };
  }

  // Date and time only — never the name. The caller confirms the name to us.
  s.foundBooking = { uid: match.uid, startIso: match.start, name: attendeeName(match) };
  // They're on the books already: exempt from both gates so they aren't marched
  // through the postcode and the four fault questions all over again.
  s.isExistingCustomer = true;
  state.touch(s, { type: 'found_booking', uid: match.uid });

  return {
    ok: true,
    found: true,
    label: time.spokenLabel(match.start),
    say: `I've got a visit booked for ${time.spokenLabel(match.start)}. Can I just take the name it's under?`,
  };
}

function attendeeName(b) {
  if (b.attendees && b.attendees[0] && b.attendees[0].name) return b.attendees[0].name;
  if (b.attendee && b.attendee.name) return b.attendee.name;
  return '';
}

function confirmName(s, body) {
  if (!s.foundBooking) {
    return { ok: false, verified: false, say: `Let me pull that up first — what number would it be under?` };
  }
  const given = String(body.name || '').toLowerCase().replace(/[^a-z]/g, '');
  const real = String(s.foundBooking.name || '').toLowerCase().replace(/[^a-z]/g, '');
  const match = given && real && (real.includes(given) || given.includes(real));

  if (!match) {
    // Never reveal the real name on a mismatch.
    s.foundBooking = null;
    return {
      ok: true,
      verified: false,
      say: `That's not the name I've got on it, I'm afraid. Best ring the office on ${OFFICE} and they'll sort it out for you.`,
    };
  }
  s.foundBooking.verified = true;
  return { ok: true, verified: true, say: "That's the one. Did you want to move it or cancel it?" };
}

async function rescheduleBooking(s, body) {
  if (!s.foundBooking || !s.foundBooking.verified) {
    return { ok: false, reason: 'not_found', say: `Let me find the booking first — what number is it under?` };
  }
  if (s.emergency) return bookingBlocked(s);

  const slot = findOfferedSlot(s, body.chosenSlotLabel);
  if (!slot) {
    const labels = s.offeredSlots.map((x) => x.label);
    return {
      ok: false,
      reason: 'slot_not_offered',
      offered: labels,
      say: labels.length ? `I've got ${labels.join(', or ')}. Which suits?` : 'Let me look at the diary and find you a time.',
    };
  }

  const r = await cal.rescheduleBooking(s.foundBooking.uid, { startIso: slot.startIso });
  if (!r.ok) {
    const already = r.status === 400;
    return {
      ok: false,
      reason: already ? 'not_reschedulable' : 'failed',
      say: already
        ? "That one's already been cancelled, by the look of it. Shall I get you a new time instead?"
        : `I can't move it just now — could you ring the office on ${OFFICE}?`,
    };
  }
  const previousUid = s.foundBooking.uid;
  s.foundBooking.uid = (r.json.data && r.json.data.uid) || s.foundBooking.uid;
  s.outcome = 'rescheduled';
  state.touch(s, { type: 'rescheduled', label: slot.label });
  // Cal.com mints a new uid on reschedule; carry it into the sheet row.
  sheets.logStatusChange(previousUid, 'Rescheduled', slot.label, s.foundBooking.uid);
  email.sendChanged(s, slot.label, 'rescheduled');
  return { ok: true, say: `That's moved to ${slot.label}. You'll get a new confirmation email through shortly.` };
}

async function cancelBooking(s) {
  if (!s.foundBooking || !s.foundBooking.verified) {
    return { ok: false, reason: 'not_found', say: `Let me find the booking first — what number is it under?` };
  }
  const r = await cal.cancelBooking(s.foundBooking.uid, 'Cancelled by caller on the phone');
  if (!r.ok) {
    const already = r.status === 400;
    return {
      ok: false,
      reason: already ? 'already_cancelled' : 'failed',
      say: already
        ? "That one's already been cancelled, so there's nothing to do there."
        : `I can't cancel it just now — could you ring the office on ${OFFICE}?`,
    };
  }
  s.outcome = 'cancelled';
  state.touch(s, { type: 'cancelled' });
  sheets.logStatusChange(s.foundBooking.uid, 'Cancelled', null, null);
  email.sendChanged(s, time.spokenLabel(s.foundBooking.startIso), 'cancelled');
  return { ok: true, say: "That's cancelled for you. Was there anything else?" };
}

/* ------------------------------------------------------------ 7. emergency */

/**
 * The safety wording is returned BY THE TOOL, not left to the model.
 *
 * A scenario run caught the assistant flagging the emergency correctly and then
 * skipping straight to "shall the office ring you?" — no windows, no 0800 number.
 * The instruction to say it was in the prompt, and the prompt got skipped. Same
 * lesson as the booking gate: if it must never fail, it lives in code.
 */
const SAFETY_SCRIPTS = {
  gas:
    "Right, stop there — that's a gas emergency, so let's get you safe first. Don't touch any switches and don't light anything. Open your windows, turn the gas off at the meter if you can get to it safely, get everyone out of the house, and ring the National Gas Emergency Service on 0800 111 999 straight away. They'll come out and make it safe.",
  co:
    "Turn the boiler off if you can, open the windows, and get everyone outside into fresh air. Then ring the National Gas Emergency Service on 0800 111 999. If anyone's actually feeling unwell, ring 999.",
  water:
    "Turn it off at the mains if you can get to it safely, and keep away from it. We don't do out-of-hours call-outs, so ring the office on {OFFICE} when they open — Monday to Friday, eight till five — and they'll get someone to you.",
  electrical:
    "Turn the electric off at the consumer unit if you can do it safely, and keep away from it. We don't do out-of-hours call-outs, so ring the office on {OFFICE} when they open — Monday to Friday, eight till five. If you can smell burning or see flames, ring 999.",
};

function flagEmergency(s, body) {
  const kind = String(body.kind || 'gas').trim().toLowerCase();
  s.emergency = SAFETY_SCRIPTS[kind] ? kind : 'gas';
  s.outcome = 'emergency';
  state.touch(s, { type: 'emergency', kind: s.emergency });
  auditLog.write({ type: 'outcome', outcome: 'emergency', conversationId: s.conversationId, kind: s.emergency });
  sheets.logCall(s, 'emergency', `${s.emergency} — safety advice given, booking refused`);

  const script = (SAFETY_SCRIPTS[s.emergency] || SAFETY_SCRIPTS.gas).replace('{OFFICE}', OFFICE);
  return {
    ok: true,
    kind: s.emergency,
    // The assistant is told to read this out word for word.
    say: script,
    then: "After saying that, you may ask ONE question: whether they'd like the office to ring them once the property is made safe. Then close the call warmly. Do not offer a booking.",
  };
}

module.exports = {
  checkServiceArea,
  checkSystemType,
  eventTypeForLane,
  nextQuestionTool,
  recordDetails,
  checkAvailability,
  bookAppointment,
  findBooking,
  confirmName,
  rescheduleBooking,
  cancelBooking,
  flagEmergency,
  findOfferedSlot,
  probeFor,
};
