'use strict';

/**
 * The refusals are the product. These run with no LLM and no network for the
 * gate cases — if any of these fail, the assistant can book a visit that shouldn't
 * exist, and someone takes a day off work for an engineer who never comes.
 */

require('dotenv').config();
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

const state = require('../src/state');
const tools = require('../src/tools');
const postcode = require('../src/postcode');
const questions = require('../src/questions');
const jobDescription = require('../src/jobDescription');

let calTouched = 0;
const cal = require('../src/calcom');
const realGetSlots = cal.getSlots;
cal.getSlots = async (...args) => { calTouched += 1; return realGetSlots(...args); };

function fresh(id = 'test-call') {
  state.reset();
  calTouched = 0;
  return state.get(id, '+447986321440');
}

function fullyQualified(s) {
  s.location.addressLine1 = '14 Oak Road, Didsbury';
  s.location.postcode = 'M20 2RT';
  s.location.inArea = true;
  s.systemCovered = true;
  s.systemType = 'Worcester combi';
  s.callerRelationship = 'owner';
  s.lane = 'repair';
  s.diagnostics.issueType = 'repair';
  s.diagnostics.fault = 'no hot water, heating fine';
  s.diagnostics.makeModel = 'Worcester combi';
  s.diagnostics.symptoms = 'pilot light out';
  s.contact.firstName = 'James';
  s.contact.surname = 'Whitfield';
  s.contact.name = 'James Whitfield';
  s.contact.phone = '07986 321 440';
  s.contact.email = 'james.whitfield@gmail.com';
  return s;
}

/* ------------------------------------------------------------------ Gate A */

test('gate A needs first line, postcode and in-area — and nothing more', () => {
  const s = fresh();
  assert.equal(state.gateA(s), false, 'empty state');

  s.location.postcode = 'M20 2RT';
  assert.equal(state.gateA(s), false, 'postcode alone is not enough');

  s.location.addressLine1 = '14 Oak Road';
  assert.equal(state.gateA(s), false, 'area not yet confirmed');

  s.location.inArea = 'unclear';
  assert.equal(state.gateA(s), false, '"unclear" must not open the gate');

  s.location.inArea = true;
  assert.equal(state.gateA(s), true, 'house number, street and postcode is all an engineer needs');
});

test('the town is never required and never asked for', () => {
  const s = fresh();
  // Exactly the client's failing case: "It's 14 Oak Road", then "M20 2RT".
  tools.recordDetails(s, { addressLine1: '14 Oak Road' });
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });

  assert.equal(state.gateA(s), true, 'Gate A must open with no further address question');
  assert.ok(!state.missingFields(s).some((f) => /address/i.test(f)),
    'no outstanding address question');
  assert.ok(!/address|town|street/i.test(tools.nextQuestionTool(s).say),
    'must not ask for more address');
});

test('a model still sending the old `address` field does not stall the gate', () => {
  const s = fresh();
  tools.recordDetails(s, { address: '14 Oak Road' });
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });
  assert.equal(s.location.addressLine1, '14 Oak Road');
  assert.equal(state.gateA(s), true);
});

test('gate B follows the lane, and "not given" counts as answered', () => {
  const s = fresh();
  s.systemCovered = true;

  // Repair still needs its fault questions.
  s.lane = 'repair';
  s.diagnostics.fault = 'no heating';
  assert.equal(state.gateB(s), false);
  s.diagnostics.makeModel = 'not given';
  s.diagnostics.symptoms = 'not given';
  assert.equal(state.gateB(s), true, '"not given" is a complete answer');
});

test('a service call books WITHOUT any fault questions', () => {
  const s = fresh();
  s.systemCovered = true;
  s.lane = 'service';
  assert.equal(state.gateB(s), false);

  s.diagnostics.serviceType = 'certificate';
  s.diagnostics.applianceCount = 'boiler and a hob';
  assert.equal(state.gateB(s), true, 'service must not be locked out by fault fields');
  assert.equal(s.diagnostics.fault, null, 'and must never have been asked for a fault');
});

test('a new boiler call gates on the survey questions, not the fault ones', () => {
  const s = fresh();
  s.systemCovered = true;
  s.lane = 'newBoiler';
  s.diagnostics.currentSystem = 'back boiler, about 20 years old';
  assert.equal(state.gateB(s), false, 'still needs the sizing question');
  s.diagnostics.bedrooms = '3 bed, 1 bath';
  assert.equal(state.gateB(s), true);
});

test('a system we do not cover never opens gate B, however complete the answers', () => {
  const s = fullyQualified(fresh());
  assert.equal(state.gateB(s), true);

  s.systemCovered = false;
  assert.equal(state.gateB(s), false, 'declined before details, not after');
  s.systemCovered = 'unclear';
  assert.equal(state.gateB(s), false, 'never guess the trade');
});

/* -------------------------------------------- availability must not leak out */

test('check_availability with both gates shut refuses AND never touches Cal.com', async () => {
  const s = fresh();
  const r = await tools.checkAvailability(s, { dayPreference: 'Wednesday', timePreference: 'morning' });

  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'gate');
  assert.ok(r.missing.includes('postcode'), 'should name what is missing');
  assert.equal(calTouched, 0, 'Cal.com must not be called while the gate is shut');
  assert.ok(!/\d(am|pm)/i.test(r.say), `must not mention a time: "${r.say}"`);
});

test('check_availability refuses when only gate A is open', async () => {
  const s = fresh();
  s.location.addressLine1 = '14 Oak Road';
  s.location.postcode = 'M20 2RT';
  s.location.inArea = true;

  const r = await tools.checkAvailability(s, { dayPreference: 'Wednesday' });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'gate');
  assert.equal(calTouched, 0);
});

/* ------------------------------------------------ the anti-hallucination lock */

test('book refuses a time that was never offered', async () => {
  const s = fullyQualified(fresh());
  s.offeredSlots = [{ label: 'Wednesday the 12th at 9am', startIso: '2026-08-12T09:00:00.000+01:00' }];

  const r = await tools.bookAppointment(s, { chosenSlotLabel: 'Tuesday at 4pm' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'slot_not_offered');
  assert.equal(s.bookingUid, null);
});

test('book refuses when offeredSlots is empty, however confident the label', async () => {
  const s = fullyQualified(fresh());
  const r = await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 9am' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'slot_not_offered');
});

test('book refuses with a missing contact field and names it', async () => {
  const s = fullyQualified(fresh());
  s.contact.email = null;
  s.offeredSlots = [{ label: 'Wednesday the 12th at 9am', startIso: '2026-08-12T09:00:00.000+01:00' }];

  const r = await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 9am' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_field');
  assert.deepEqual(r.missing, ['email']);
});

test('book refuses an empty chosen time', async () => {
  const s = fullyQualified(fresh());
  s.offeredSlots = [{ label: 'Wednesday the 12th at 9am', startIso: '2026-08-12T09:00:00.000+01:00' }];
  const r = await tools.bookAppointment(s, { chosenSlotLabel: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_field');
});

/* ------------------------------------------------------ emergency is terminal */

test('an emergency shuts booking for the rest of the call', async () => {
  const s = fullyQualified(fresh());
  s.offeredSlots = [{ label: 'Wednesday the 12th at 9am', startIso: '2026-08-12T09:00:00.000+01:00' }];
  tools.flagEmergency(s, { kind: 'gas' });

  const avail = await tools.checkAvailability(s, { dayPreference: 'Wednesday' });
  assert.equal(avail.ok, false);
  assert.equal(avail.reason, 'emergency');
  assert.equal(calTouched, 0);

  const book = await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 9am' });
  assert.equal(book.ok, false);
  assert.equal(book.reason, 'emergency');
  assert.equal(s.bookingUid, null);

  assert.ok(!/book|schedul/i.test(avail.say.replace(/can't book|no booking/gi, '')),
    `emergency reply must not offer a booking: "${avail.say}"`);
});

/* ------------------------------------------------------------- service area */

test('postcode matching: in, out, edge and unheard', () => {
  assert.equal(postcode.check('M20 2RT').inArea, true);
  assert.equal(postcode.check('BL1 1AA').inArea, true);
  assert.equal(postcode.check('EH1 1YZ').inArea, false, 'Edinburgh is 200 miles away');
  assert.equal(postcode.check('SK10 1AA').inArea, 'unclear', 'Macclesfield is the edge of the patch');
  assert.equal(postcode.check('WA5 1AA').inArea, 'unclear', 'Warrington is the edge of the patch');

  const misheard = postcode.check('em twenty something');
  assert.equal(misheard.inArea, 'unclear');
  assert.equal(misheard.reask, true, 'a misheard postcode is re-asked, never guessed');
});

test('out of area never opens gate A and is not written to the diary', async () => {
  const s = fresh();
  tools.checkServiceArea(s, { postcode: 'EH1 1YZ' });
  assert.equal(s.location.inArea, false);
  assert.equal(state.gateA(s), false);

  const r = await tools.checkAvailability(s, { dayPreference: 'Wednesday' });
  assert.equal(r.ok, false);
  assert.equal(calTouched, 0);
});

/* ------------------------------------------------- the FAQ return path (Bug 1) */

test('next_question hands back the outstanding question, never a time offer', () => {
  const s = fresh();
  const atStart = tools.nextQuestionTool(s);
  assert.ok(/postcode/i.test(atStart.say), `expected the postcode question, got: "${atStart.say}"`);

  s.location.postcode = 'M20 2RT';
  s.location.inArea = true;
  s.contact.firstName = 'James';
  s.location.addressLine1 = '14 Oak Road';
  s.systemCovered = true;
  s.callerRelationship = 'owner';
  s.lane = 'repair';
  s.diagnostics.issueType = 'repair';
  s.diagnostics.fault = 'no hot water';
  s.diagnostics.probeAnswer = 'heating is fine';

  const mid = tools.nextQuestionTool(s);
  assert.ok(/make/i.test(mid.say), `expected the make question, got: "${mid.say}"`);
  assert.ok(!/\d(am|pm)|appointment|slot|book you in/i.test(mid.say),
    `must not drift to booking: "${mid.say}"`);
});

/* ------------------------------------------------------- job description order */

test('job description is built server-side in a fixed order, dropping blanks', () => {
  const s = fullyQualified(fresh());
  s.diagnostics.gcOrErrCode = 'EA';
  s.diagnostics.probeAnswer = 'heating still on';

  const desc = jobDescription.build(s);
  assert.ok(desc.startsWith('Repair — no hot water'), desc);
  assert.ok(desc.includes('Worcester combi'), desc);
  assert.ok(desc.includes('code EA'), desc);
  assert.ok(desc.includes('M20 2RT'), desc);

  s.diagnostics.makeModel = 'not given';
  s.diagnostics.gcOrErrCode = 'not given';
  const sparse = jobDescription.build(s);
  assert.ok(!/not given/i.test(sparse), 'a blank beats a guess — "not given" is dropped');
});

/* -------------------------------------------- existing customer name privacy */

test('a name mismatch never reveals the real name', async () => {
  const s = fresh();
  s.foundBooking = { uid: 'abc', startIso: '2026-08-12T09:00:00.000+01:00', name: 'James Whitfield' };

  const r = tools.confirmName(s, { name: 'Sarah Connor' });
  assert.equal(r.verified, false);
  assert.ok(!/whitfield/i.test(r.say), `must not leak the real name: "${r.say}"`);

  const resched = await tools.rescheduleBooking(s, { chosenSlotLabel: 'Wednesday the 12th at 9am' });
  assert.equal(resched.ok, false, 'a failed name check blocks rescheduling');
});

test('reschedule and cancel both require a verified find first', async () => {
  const s = fresh();
  const r1 = await tools.rescheduleBooking(s, { chosenSlotLabel: 'Wednesday the 12th at 9am' });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'not_found');

  const r2 = await tools.cancelBooking(s);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'not_found');
});

/* ------------------------- the existing-customer exemption can't be forged */

test('the LLM cannot grant itself the existing-customer exemption', async () => {
  const s = fresh();
  // Every field the model is allowed to send, plus the one it must never set.
  tools.recordDetails(s, {
    isExistingCustomer: true,
    foundBooking: { uid: 'forged', verified: true },
    gate: { A: true, B: true },
    address: '1 Nowhere',
  });

  assert.equal(s.isExistingCustomer, false, 'record_details must not set the exemption');
  assert.equal(s.foundBooking, null, 'record_details must not forge a found booking');
  assert.equal(state.gateA(s), false);
  assert.equal(state.gateB(s), false);

  const r = await tools.checkAvailability(s, { dayPreference: 'Wednesday' });
  assert.equal(r.ok, false);
  assert.equal(calTouched, 0, 'Cal.com must still not be touched');
});

test('a matched booking exempts the caller from both gates', () => {
  const s = fresh();
  assert.equal(state.gateA(s), false);
  // What find_booking does on a real match.
  s.isExistingCustomer = true;
  assert.equal(state.gateA(s), true, 'they were gated when the visit was first booked');
  assert.equal(state.gateB(s), true);
  assert.deepEqual(state.missingFields(s), [], 'nothing left to ask them');
});

/* ------------------------------------------- what we cover, and what we don't */

test('system scope: gas in, everything else declined before details', () => {
  const sys = require('../src/systemType');

  for (const yes of ['gas boiler', 'Worcester combi', 'Vaillant', 'back boiler', 'gas hob']) {
    assert.equal(sys.check(yes).covered, true, `${yes} should be covered`);
  }
  for (const no of ['air conditioning', 'heat pump', 'oil boiler', 'LPG', 'storage heaters', 'solar panels']) {
    const r = sys.check(no);
    assert.equal(r.covered, false, `${no} should be declined`);
    assert.ok(/sorry|afraid/i.test(r.say), `should decline politely: "${r.say}"`);
    assert.ok(!/postcode|make|fault/i.test(r.say), 'must not keep taking details');
  }
  assert.equal(sys.check('some sort of heating thing').covered, 'unclear', 'never guess the trade');

  // "electric boiler" contains "boiler" — the wrong answer sends a gas engineer
  // to something they cannot legally touch.
  assert.equal(sys.check('electric boiler').covered, false, 'not-covered must win over covered');
});

test('an air-con caller is declined and never asked a fault question', () => {
  const s = fresh();
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });
  tools.recordDetails(s, { addressLine1: '14 Oak Road' });

  const r = tools.checkSystemType(s, { systemDescription: "it's the air conditioning" });
  assert.equal(r.covered, false);
  assert.ok(/refrigeration/i.test(r.say), `should name the right trade: "${r.say}"`);
  assert.equal(state.gateB(s), false, 'must never reach the diary');
  assert.ok(!/fault|make|what.*doing/i.test(tools.nextQuestionTool(s).say),
    'no fault questions for a system we do not cover');
});

test('the lane picks the appointment type', () => {
  // Restore afterwards: node:test shares one process, and leaving fake ids behind
  // sends every live test after this one at an event type that doesn't exist.
  const saved = {
    repair: process.env.CALCOM_EVENT_TYPE_ID,
    service: process.env.CALCOM_EVENT_TYPE_SERVICE,
    survey: process.env.CALCOM_EVENT_TYPE_SURVEY,
  };
  const restore = () => {
    process.env.CALCOM_EVENT_TYPE_ID = saved.repair;
    if (saved.service) process.env.CALCOM_EVENT_TYPE_SERVICE = saved.service;
    if (saved.survey) process.env.CALCOM_EVENT_TYPE_SURVEY = saved.survey;
  };

  process.env.CALCOM_EVENT_TYPE_ID = '111';
  process.env.CALCOM_EVENT_TYPE_SERVICE = '222';
  process.env.CALCOM_EVENT_TYPE_SURVEY = '333';
  assert.equal(tools.eventTypeForLane('repair'), '111');
  assert.equal(tools.eventTypeForLane('service'), '222');
  assert.equal(tools.eventTypeForLane('newBoiler'), '333', 'a survey is not a two-hour repair slot');

  // A missing env var must never stop a booking.
  delete process.env.CALCOM_EVENT_TYPE_SURVEY;
  assert.equal(tools.eventTypeForLane('newBoiler'), '111', 'falls back rather than failing');

  restore();
  assert.notEqual(process.env.CALCOM_EVENT_TYPE_ID, '111', 'env restored for later tests');
});

/* -------------------------------- the model cannot award itself an open gate */

test('a model-declared "existing" lane does not open gate B', () => {
  const s = fresh();
  s.systemCovered = true;
  s.lane = 'existing';   // exactly what the model did to an air-con caller
  assert.equal(s.isExistingCustomer, false);
  assert.equal(state.gateB(s), false,
    'an empty field list must not be vacuously satisfied');

  // The real route stays open: a genuine find_booking match still exempts them.
  s.isExistingCustomer = true;
  assert.equal(state.gateB(s), true);
});

test('the emergency lane never opens gate B', () => {
  const s = fresh();
  s.systemCovered = true;
  s.lane = 'emergency';
  assert.equal(state.gateB(s), false);
});

test('an unchecked system never opens gate B', () => {
  const s = fresh();
  s.lane = 'repair';
  s.diagnostics.fault = 'no heating';
  s.diagnostics.makeModel = 'Worcester';
  s.diagnostics.symptoms = 'not given';
  assert.equal(s.systemCovered, null, 'system check has not happened');
  assert.equal(state.gateB(s), false, 'cannot book without knowing what it is');

  s.systemCovered = true;
  assert.equal(state.gateB(s), true);
});

test('an unknown lane name cannot open gate B', () => {
  const s = fresh();
  s.systemCovered = true;
  s.lane = 'somethingElse';
  assert.equal(state.gateB(s), false);
});

/* ------------------------------------------------- the question-loop family */

test('recording the system through record_details opens the check (loop 1)', () => {
  const s = fresh();
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });
  tools.recordDetails(s, { addressLine1: '14 Oak Road' });

  // The model has two doors to this answer; both must turn the same lock.
  const r = tools.recordDetails(s, { systemType: 'gas boiler' });
  assert.equal(s.systemCovered, true, 'record_details must run the system check too');
  assert.ok(!/what have you got/i.test(r.say), `must not re-ask: "${r.say}"`);
});

test('the whole address in one field satisfies gate A (loop 2)', () => {
  const s = fresh();
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });
  tools.recordDetails(s, { addressLine1: 'Flat 2, 14 Oak Road, Didsbury' });
  assert.equal(state.gateA(s), true);

  // Whatever key the model reaches for, the address must land somewhere that counts.
  const b = fresh('alt');
  tools.checkServiceArea(b, { postcode: 'M20 2RT' });
  tools.recordDetails(b, { address: '14 Oak Road' });
  assert.equal(state.gateA(b), true, 'the legacy field name must still work');
});

test('no question is ever asked a third time (loop 3)', () => {
  const s = fresh();
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });
  tools.recordDetails(s, { addressLine1: '14 Oak Road', systemType: 'gas boiler' });

  const asked = [];
  for (let i = 0; i < 8; i++) {
    const r = tools.recordDetails(s, {});   // she asked; the caller gave nothing
    asked.push(r.say);
  }
  const counts = asked.reduce((m, say) => { m[say] = (m[say] || 0) + 1; return m; }, {});
  const worst = Math.max(...Object.values(counts));
  assert.ok(worst <= 3, `the same question came back ${worst} times: ${JSON.stringify(counts).slice(0, 200)}`);
  assert.equal(s.callerRelationship, 'not given', 'a soft field is accepted as blank and the call moves on');
});

test('a hard blocker stops rather than looping', () => {
  const s = fresh();
  for (let i = 0; i < 5; i++) tools.nextQuestionTool(s);   // never gives a postcode

  assert.equal(s.stuck, 'postcode');
  const r = tools.nextQuestionTool(s);
  assert.ok(/office/i.test(r.say), `should hand to the office: "${r.say}"`);
  assert.equal(state.gateA(s), false, 'and must still never book');
});

test('the loop breaker cannot open a gate on its own', () => {
  const s = fresh();
  s.systemCovered = true;
  s.lane = 'repair';
  // Exhaust every soft field; `fault` is a hard blocker and must still hold.
  for (let i = 0; i < 12; i++) tools.nextQuestionTool(s);
  assert.equal(state.gateB(s), false, 'giving up on questions must never mean booking anyway');
});

/* ------------------------------------------------- contact details (loop 4) */

test('a name given early in the call is never asked for again', () => {
  const s = fresh();
  tools.recordDetails(s, { name: 'James Whitfield' });
  assert.equal(s.contact.firstName, 'James');
  assert.equal(s.contact.surname, 'Whitfield');
  assert.equal(s.contact.name, 'James Whitfield');

  // Get as far as a chosen slot, where the remaining details are collected.
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });
  tools.recordDetails(s, { addressLine1: '14 Oak Road', systemType: 'gas boiler', callerRelationship: 'owner', lane: 'repair' });
  tools.recordDetails(s, { fault: 'no heating', probeAnswer: 'all of them', makeModel: 'Worcester', symptoms: 'not given' });
  s.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: '2026-08-12T08:00:00.000+01:00' }];

  const missing = state.missingFields(s);
  assert.ok(!missing.includes('firstName') && !missing.includes('surname'), 'the name is already known');
  assert.ok(!/name/i.test(tools.nextQuestionTool(s).say), 'must not ask for it again');
});

test('the first name is asked early, the rest after a time is chosen', () => {
  const s = fresh();
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });

  // Straight after "we cover you" — before the address, before the fault. This is
  // the whole point: a name collected in the last thirty seconds can never be used.
  assert.equal(state.missingFields(s)[0], 'firstName');
  assert.ok(/first name/i.test(tools.nextQuestionTool(s).say));

  tools.recordDetails(s, { firstName: 'Akrit' });
  tools.recordDetails(s, { addressLine1: '14 Oak Road', systemType: 'gas boiler', callerRelationship: 'owner', lane: 'repair' });
  tools.recordDetails(s, { fault: 'no heating', probeAnswer: 'all of them', makeModel: 'Worcester', symptoms: 'not given' });

  // No slot yet — asking for an email before we know we can even come out is
  // the wrong order, so she should be heading for the diary.
  assert.ok(!state.missingFields(s).some((f) => ['surname', 'phone', 'email'].includes(f)));
  assert.ok(/day suits|booked in/i.test(tools.nextQuestionTool(s).say));

  s.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: '2026-08-12T08:00:00.000+01:00' }];
  assert.deepEqual(
    state.missingFields(s).filter((f) => ['surname', 'phone', 'email'].includes(f)),
    ['surname', 'phone', 'email'],
    'and in that order once a slot is on the table'
  );
});

test('a surname is asked for spelled out, and a full name splits itself', () => {
  const s = fresh();
  // Answering "can I take your first name?" with both is two answers, not one.
  tools.recordDetails(s, { firstName: 'Akrit Sharma' });
  assert.equal(s.contact.firstName, 'Akrit');
  assert.equal(s.contact.surname, 'Sharma');

  const b = fresh('spell');
  b.location.postcode = 'M20 2RT';
  b.location.inArea = true;
  b.contact.firstName = 'Akrit';
  b.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: '2026-08-12T08:00:00.000+01:00' }];
  b.location.addressLine1 = '14 Oak Road';
  b.systemCovered = true;
  b.callerRelationship = 'owner';
  b.lane = 'repair';
  Object.assign(b.diagnostics, { fault: 'no heating', probeAnswer: 'all', makeModel: 'Worcester', symptoms: 'none' });

  assert.match(questions.LINES.surname, /spell/i, 'the surname must be spelled out, not guessed at');
  assert.equal(state.missingFields(b)[0], 'surname');
});

/* ------------------------------- the loop guard has to be survivable (R3) */

test('the model retrying book_appointment does not burn the caller\'s chances', async () => {
  const s = fullyQualified(fresh());
  s.contact.email = null;
  s.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: '2026-08-12T08:00:00.000+01:00' }];

  // Five calls inside ONE caller turn: the model can't tell why it was refused and
  // tries again. Ellie has asked the caller precisely once. Counting each retry is
  // what killed a booking at the last step with the caller sat there ready to answer.
  for (let i = 0; i < 5; i++) {
    await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
  }
  assert.equal(s.asked.email, 1, `one question asked, one strike — got ${s.asked.email}`);
  assert.equal(s.stuck, null, 'and the call is still alive');
});

test('a caller who really never answers still stops the loop', async () => {
  const s = fullyQualified(fresh());
  s.contact.email = null;
  s.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: '2026-08-12T08:00:00.000+01:00' }];

  const reasons = [];
  for (let i = 0; i < 5; i++) {
    const r = await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
    reasons.push(r.reason);
    tools.recordDetails(s, {});   // the caller was asked and gave nothing back
  }
  assert.ok(reasons.includes('stuck'), `should escalate, got: ${JSON.stringify(reasons)}`);
  assert.equal(s.bookingUid, null, 'and must still never book without an email');
});

test('giving the answer at last reopens a stuck call', async () => {
  const s = fullyQualified(fresh());
  s.contact.email = null;
  s.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: '2026-08-12T08:00:00.000+01:00' }];

  for (let i = 0; i < 5; i++) {
    await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
    tools.recordDetails(s, {});
  }
  assert.equal(s.stuck, 'email', 'precondition: the call gave up on the email');

  // `stuck` was set once and never cleared anywhere, so this caller — who is right
  // there spelling out their email — got the office handoff for the rest of the call.
  tools.recordDetails(s, { email: 'akrit@example.com' });
  assert.equal(s.stuck, null, 'the answer arrived; the call carries on');

  const r = await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
  assert.notEqual(r.reason, 'stuck', `must not still be handing off: ${JSON.stringify(r)}`);
  assert.ok(!/ring the office/i.test(r.say || ''), `and must not still say it: "${r.say}"`);
});

/* ------------------------------- a fault they already named (R5) */

test('a caller who names the fault is not asked the generic fork again', () => {
  const s = fresh();
  tools.checkServiceArea(s, { postcode: 'M20 2RT' });
  tools.recordDetails(s, { firstName: 'Akrit', addressLine1: '14 Oak Road', systemType: 'gas boiler' });

  // The opening line was "it's making a banging noise". That IS the fault.
  tools.recordDetails(s, { lane: 'repair', fault: 'making a banging noise' });

  const r = tools.nextQuestionTool(s);
  assert.match(r.say, /banging|whistl|kettl/i, `expected the noise probe, got: "${r.say}"`);
  assert.ok(!/hot water|heating.*gone/i.test(r.say),
    `must not ask what they already told us: "${r.say}"`);
});

test('the probe still never jumps the queue in front of the area check', () => {
  const s = fresh();
  // A fault arrives before we know where the property is — which happens on almost
  // every call, since people lead with the problem.
  tools.recordDetails(s, { lane: 'repair', fault: 'water pouring out underneath' });
  const r = tools.nextQuestionTool(s);
  assert.match(r.say, /postcode/i, `location comes first, got: "${r.say}"`);
});

/* --------------------------- a booking that failed must leave a trace (R6) */

test('a failed booking is written down and the manager is told', async () => {
  const s = fullyQualified(fresh());
  const iso = '2026-08-12T08:00:00.000+01:00';
  s.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: iso }];

  const sheets = require('../src/sheets');
  const email = require('../src/email');
  const real = { slots: cal.getSlots, create: cal.createBooking, log: sheets.logBooking, mail: email.sendBookingFailed };
  const rows = [], mails = [];
  cal.getSlots = async () => ({ ok: true, slots: [iso] });
  cal.createBooking = async () => ({ ok: false, status: 500, json: { error: 'boom' } });
  sheets.logBooking = (st, label, notes, status) => rows.push({ label, status, name: st.contact.name, phone: st.contact.phone });
  email.sendBookingFailed = (st, label) => mails.push({ label, phone: st.contact.phone });

  try {
    const r = await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'booking_failed');

    // Before this, the whole thing vanished: an in-memory event swept after two
    // hours, on a disk that doesn't survive a deploy. Nobody could ring them back.
    assert.equal(rows.length, 1, 'the office needs a row for this');
    assert.equal(rows[0].status, 'NEEDS CALLBACK');
    assert.equal(rows[0].label, 'Wednesday the 12th at 8am', 'including the time they wanted');
    assert.equal(rows[0].phone, '07986 321 440', 'and a number to ring');
    assert.equal(mails.length, 1, 'and the manager needs telling');

    // The model retries; the office should not get three identical rows.
    await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
    assert.equal(rows.length, 1, 'logged once per call, however many retries');
  } finally {
    cal.getSlots = real.slots;
    cal.createBooking = real.create;
    sheets.logBooking = real.log;
    email.sendBookingFailed = real.mail;
  }
});

test('a call that recovers closes its own callback row', async () => {
  const s = fullyQualified(fresh());
  const iso = '2026-08-12T08:00:00.000+01:00';
  s.offeredSlots = [{ label: 'Wednesday the 12th at 8am', startIso: iso }];

  const sheets = require('../src/sheets');
  const email = require('../src/email');
  const real = { slots: cal.getSlots, create: cal.createBooking, log: sheets.logBooking,
    mail: email.sendBookingFailed, booked: email.sendBooked, resolve: sheets.resolveLoss };
  let failFirst = true, resolved = [];
  cal.getSlots = async () => ({ ok: true, slots: [iso] });
  cal.createBooking = async () => {
    if (failFirst) { failFirst = false; return { ok: false, status: 500, json: {} }; }
    return { ok: true, status: 200, json: { data: { uid: 'uid-recovered' } } };
  };
  sheets.logBooking = () => {};
  sheets.resolveLoss = (ref) => resolved.push(ref);
  email.sendBookingFailed = () => {};
  email.sendBooked = () => {};

  try {
    await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
    const ok = await tools.bookAppointment(s, { chosenSlotLabel: 'Wednesday the 12th at 8am' });
    assert.equal(ok.ok, true);
    // Otherwise the office rings a customer who is already in the diary.
    assert.deepEqual(resolved, ['test-call']);
  } finally {
    Object.assign(cal, { getSlots: real.slots, createBooking: real.create });
    Object.assign(sheets, { logBooking: real.log, resolveLoss: real.resolve });
    Object.assign(email, { sendBookingFailed: real.mail, sendBooked: real.booked });
  }
});

test('the console shows the fields the gate actually reads', () => {
  // "Job type" sat at the top of Gate B's checklist and is not a gate field in any
  // lane, so the one panel meant to explain a stuck call was misleading about why.
  const fs = require('node:fs');
  const widget = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'widget.html'), 'utf8');
  const block = widget.slice(widget.indexOf('var LANE_CHECKS'), widget.indexOf('var TICKMARK'));

  assert.ok(!/issueType/.test(block), 'issueType is not a Gate B field');
  for (const [lane, fields] of Object.entries(state.LANE_FIELDS)) {
    for (const f of fields) {
      assert.ok(block.includes(`'${f}'`), `${lane}: the console never shows ${f}`);
    }
  }
});

/* --------------------------------------------- transient failures and retries */

test('a write is never retried when the booking may already have landed', () => {
  // Exported for exactly this: retrying a POST after a timeout or a 5xx can book
  // the same caller twice, which is worse than telling them to ring the office.
  const { safeToRetry } = require('../src/calcom');

  assert.equal(safeToRetry('POST', 0), false, 'timeout on a write: may have landed');
  assert.equal(safeToRetry('POST', 502), false, 'server error on a write: may have landed');
  assert.equal(safeToRetry('POST', 429), true, 'rate limited means it was never processed');

  assert.equal(safeToRetry('GET', 0), true);
  assert.equal(safeToRetry('GET', 500), true);
  assert.equal(safeToRetry('GET', 404), false, 'a real answer, not a blip');
  assert.equal(safeToRetry('GET', 400), false);
});
