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
  s.location.address = '14 Oak Road, Didsbury';
  s.location.postcode = 'M20 2RT';
  s.location.inArea = true;
  s.diagnostics.issueType = 'repair';
  s.diagnostics.fault = 'no hot water, heating fine';
  s.diagnostics.makeModel = 'Worcester combi';
  s.diagnostics.symptoms = 'pilot light out';
  s.contact.name = 'James Whitfield';
  s.contact.phone = '07986 321 440';
  s.contact.email = 'james.whitfield@gmail.com';
  return s;
}

/* ------------------------------------------------------------------ Gate A */

test('gate A is shut until postcode, address AND in-area all hold', () => {
  const s = fresh();
  assert.equal(state.gateA(s), false, 'empty state');

  s.location.postcode = 'M20 2RT';
  assert.equal(state.gateA(s), false, 'postcode alone is not enough');

  s.location.address = '14 Oak Road';
  assert.equal(state.gateA(s), false, 'area not yet confirmed');

  s.location.inArea = 'unclear';
  assert.equal(state.gateA(s), false, '"unclear" must not open the gate');

  s.location.inArea = true;
  assert.equal(state.gateA(s), true);
});

test('gate B needs all four diagnostics, and "not given" counts as answered', () => {
  const s = fresh();
  s.diagnostics.issueType = 'repair';
  s.diagnostics.fault = 'no heating';
  assert.equal(state.gateB(s), false);

  s.diagnostics.makeModel = 'not given';
  s.diagnostics.symptoms = 'not given';
  assert.equal(state.gateB(s), true, '"not given" is a complete answer');
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
  s.location.address = '14 Oak Road';
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
  s.location.address = '14 Oak Road';
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
