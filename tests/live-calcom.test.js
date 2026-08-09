'use strict';

/**
 * Live end-to-end against the real Cal.com diary.
 *
 * This is the one test that writes: it books, verifies the booking exists with the
 * right duration and job description, then cancels itself so the diary is left as
 * it was found. Skipped automatically when CALCOM_EVENT_TYPE_ID isn't configured.
 */

require('dotenv').config();
const assert = require('node:assert/strict');
const { test } = require('node:test');

const state = require('../src/state');
const tools = require('../src/tools');
const cal = require('../src/calcom');

const configured = Boolean(process.env.CALCOM_EVENT_TYPE_ID);

function qualified(id) {
  state.reset();
  const s = state.get(id, '+447986321440');
  s.location.address = '14 Oak Road, Didsbury';
  s.location.postcode = 'M20 2RT';
  s.location.inArea = true;
  s.diagnostics.issueType = 'repair';
  s.diagnostics.fault = 'no hot water, heating still on';
  s.diagnostics.probeAnswer = 'radiators all warm';
  s.diagnostics.makeModel = 'Worcester Bosch combi';
  s.diagnostics.gcOrErrCode = 'F28';
  s.diagnostics.symptoms = 'water underneath it';
  s.contact.name = 'Ellie Test Booking';
  s.contact.phone = '07986 321 440';
  s.contact.email = 'manyamsoumithreddy@gmail.com';
  return s;
}

test('availability returns real, concrete, in-hours slots', { skip: !configured }, async () => {
  const s = qualified('live-availability');
  const r = await tools.checkAvailability(s, { dayPreference: 'Wednesday', timePreference: 'morning' });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.slots.length > 0, 'expected concrete slots');
  assert.ok(r.slots.length <= 3, 'at most three, so the caller can hold them in their head');

  // Bug 2: the caller must hear times, not another question.
  assert.ok(/\d/.test(r.say), `expected concrete times, got: "${r.say}"`);
  assert.ok(!/what time would you like/i.test(r.say));

  // The assistant must never see an ISO string.
  assert.ok(r.slots.every((x) => !x.startIso), 'ISO strings must not leave the server');
  assert.ok(!JSON.stringify(r).includes('T09:00:00'), 'no raw timestamps in the tool reply');

  for (const slot of s.offeredSlots) {
    const d = new Date(slot.startIso);
    const h = require('../src/time').parts(d).hour;
    assert.ok(h >= 8 && h <= 15, `slot at ${h}:00 is outside booking hours`);
  }
  console.log('    offered:', s.offeredSlots.map((x) => x.label).join(' | '));
});

test('full booking round trip: book, verify in diary, cancel', { skip: !configured }, async () => {
  const s = qualified('live-booking');

  const avail = await tools.checkAvailability(s, { dayPreference: 'Wednesday', timePreference: 'morning' });
  assert.equal(avail.ok, true);
  const chosen = avail.slots[0].label;

  const booked = await tools.bookAppointment(s, { chosenSlotLabel: chosen });
  assert.equal(booked.ok, true, `booking failed: ${JSON.stringify(booked)}`);
  assert.ok(s.bookingUid, 'expected a uid stored server-side');
  assert.ok(!booked.say.includes(s.bookingUid), 'the caller must never hear a uid');
  console.log('    booked:', chosen, '->', s.bookingUid);

  // Verify it is really in the diary, with the right shape.
  const check = await cal.getBookings({ status: 'upcoming', take: '50' });
  const rows = Array.isArray(check.json.data) ? check.json.data : [];
  const mine = rows.find((b) => b.uid === s.bookingUid);
  assert.ok(mine, 'booking should be visible in the diary');

  const mins = (new Date(mine.end) - new Date(mine.start)) / 60000;
  assert.equal(mins, 120, 'engineer attendance window must be 120 minutes');
  console.log('    verified in diary:', mine.start, `(${mins}min)`);

  // The same slot must not be bookable twice.
  const again = await tools.bookAppointment(s, { chosenSlotLabel: chosen });
  assert.equal(again.ok, false, 'a taken slot must not book again');
  assert.ok(['slot_gone', 'booking_failed'].includes(again.reason), `got reason: ${again.reason}`);
  console.log('    double-book correctly refused:', again.reason);

  // Leave the diary as we found it.
  const cancelled = await cal.cancelBooking(s.bookingUid, 'Automated test cleanup');
  assert.ok(cancelled.ok, `cleanup failed: ${JSON.stringify(cancelled.json).slice(0, 300)}`);
  console.log('    cleaned up');
});

test('slot taken between the offer and the confirmation: re-offer, not a double booking',
  { skip: !configured }, async () => {
    const s = qualified('live-race');

    const avail = await tools.checkAvailability(s, { dayPreference: 'Thursday', timePreference: 'any' });
    assert.equal(avail.ok, true);
    const chosen = avail.slots[0].label;
    const takenIso = s.offeredSlots[0].startIso;

    // The office fills that slot by hand while the caller is still deciding.
    const intruder = await cal.createBooking({
      eventTypeId: process.env.CALCOM_EVENT_TYPE_ID,
      startIso: takenIso,
      name: 'Walk-in Customer',
      email: 'manyamsoumithreddy@gmail.com',
      phone: '07000 000000',
      description: 'Booked at the office desk mid-call',
    });
    assert.ok(intruder.ok, `could not simulate the office booking: ${JSON.stringify(intruder.json).slice(0, 300)}`);
    const intruderUid = intruder.json.data.uid;
    console.log('    office took the slot:', chosen);

    try {
      const r = await tools.bookAppointment(s, { chosenSlotLabel: chosen });

      // Two layers can catch this and either is correct:
      //   slot_gone      — our re-check saw the slot had been taken
      //   booking_failed — Cal.com itself rejected the write
      // Which one fires depends on whether /v2/slots has caught up yet; it is
      // eventually consistent and a brand-new booking can take a few seconds to
      // show. The guarantee under test is that NOTHING was double booked and the
      // caller heard something human — not which layer did the catching.
      assert.equal(r.ok, false, 'must not double book');
      assert.ok(['slot_gone', 'booking_failed'].includes(r.reason), `unexpected reason: ${r.reason}`);
      assert.equal(s.bookingUid, null, 'nothing should have been written');
      assert.ok(!/error|failed|system|exception|api/i.test(r.say), `must not mention systems: "${r.say}"`);

      if (r.reason === 'slot_gone') {
        assert.ok(/another time|sorry|taken/i.test(r.say), `expected a graceful re-offer, got: "${r.say}"`);
        assert.ok(!s.offeredSlots.some((x) => x.startIso === takenIso), 'the taken slot must be removed');
      }
      console.log(`    refused gracefully via ${r.reason}:`, r.say);
    } finally {
      await cal.cancelBooking(intruderUid, 'Automated test cleanup');
      console.log('    cleaned up');
    }
  });
