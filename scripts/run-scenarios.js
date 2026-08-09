'use strict';

/**
 * The ten scenarios from the brief, run against the live assistant with real
 * tool execution and a real diary.
 *
 * Assertions are deliberately about BEHAVIOUR, not wording — the agent is allowed
 * to phrase things its own way. What it is not allowed to do is offer a time it
 * shouldn't, book without the gates closed, or read a safety script at someone who
 * only asked what hours we work.
 *
 *   node scripts/run-scenarios.js            # all
 *   node scripts/run-scenarios.js bug1 bug3b # a subset
 */

require('dotenv').config();
const { run, runAdaptive } = require('./converse');
const cal = require('../src/calcom');

const BASE = process.env.PUBLIC_BASE_URL;

/**
 * Anything that sounds like an appointment time being offered.
 *
 * Must match spelled-out times too — the assistant says "Wednesday the twelfth at
 * eight" rather than "8am", which reads better aloud. A digits-only pattern would
 * pass the bug-1 check for the wrong reason and fail the bug-2 check for the wrong
 * reason.
 */
const CLOCK_WORD = '(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const TIME_OFFER = new RegExp(
  [
    String.raw`\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b`,
    String.raw`\bat\s+${CLOCK_WORD}\b`,
    String.raw`\bhalf (past )?${CLOCK_WORD}\b`,
    String.raw`\b(quarter (past|to))\s+${CLOCK_WORD}\b`,
    String.raw`\bfirst thing\b`,
  ].join('|'),
  'i'
);
const BOOKING_OFFER = /\b(shall i (get you )?(book|put you|schedule)|would you like (me )?to (book|schedule)|can i book you|get you booked|put you down for|schedule a visit|book you in for)\b/i;
const SAFETY_SCRIPT = /0800\s*111\s*999|national gas emergency/i;

async function reset() {
  await fetch(`${BASE}/test/reset`, { method: 'POST' });
}

async function stateOf(id = 'no-ref') {
  const r = await fetch(`${BASE}/state/${id}`);
  if (!r.ok) return null;
  return r.json();
}

const results = [];
function check(scenario, label, passed, detail) {
  results.push({ scenario, label, passed, detail });
  console.log(`    ${passed ? 'PASS' : 'FAIL'}  ${label}${passed || !detail ? '' : `\n          ${String(detail).replace(/\n/g, ' ').slice(0, 260)}`}`);
}

/* ------------------------------------------------------------------ scenarios */

const SCENARIOS = {
  async bug1() {
    // "What time do you open?" as the second thing said on the call.
    const { text, transcript } = await run(
      ["Hello, boiler's playing up", 'What time do you open?'],
      { name: 'bug1', quiet: true }
    );
    const faqReply = transcript[1].ellie;

    check('bug1', 'answers the hours question', /eight|8\b|five|5\b|monday|friday/i.test(faqReply), faqReply);
    check('bug1', 'does NOT offer an appointment time after the FAQ', !TIME_OFFER.test(faqReply.replace(/eight till five|8 till 5|monday to friday/gi, '')), faqReply);
    check('bug1', 'does NOT offer to check the diary', !BOOKING_OFFER.test(faqReply), faqReply);
    check('bug1', 'returns to the outstanding question (postcode)', /postcode|whereabouts|where.*property/i.test(faqReply), faqReply);
    return text;
  },

  async bug2() {
    // Concrete slots, in one turn, no loop.
    await reset();
    const { transcript } = await run(
      [
        "No heating at all. It's M20 2RT, 14 Oak Road.",
        "It's a Worcester Bosch gas combi.",
        "It's my own place.",
        "It's broken — a repair. All the radiators are stone cold.",
        'No code showing. Nothing else I can see.',
        'Have you got anything Wednesday?',
      ],
      { name: 'bug2', quiet: true }
    );
    const reply = transcript[transcript.length - 1].ellie;

    check('bug2', 'offers concrete times in the same turn', TIME_OFFER.test(reply), reply);
    check('bug2', 'does not loop back with "what time would you like"', !/what time (would|do) you|which time did you have in mind/i.test(reply), reply);

    const st = await stateOf();
    const offered = st ? st.offeredSlots.map((s) => s.label) : [];
    check('bug2', 'slots came from Cal.com, not invented', offered.length > 0 && offered.length <= 3, JSON.stringify(offered));
    if (offered.length) {
      // The diary speaks in "9am"; the assistant says "nine". Accept either.
      const WORDS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
      const said = reply.toLowerCase();
      const spokenMatchesDiary = offered.every((label) => {
        const t = (label.split(' at ')[1] || '').replace(/(am|pm)/, '').trim(); // "9" or "11:30"
        const hour = Number(t.split(':')[0]);
        const asWord = WORDS[hour % 12] || '';
        return said.includes(t) || (asWord && said.includes(asWord));
      });
      check('bug2', 'every time spoken matches a time the diary returned', spokenMatchesDiary, `offered=${JSON.stringify(offered)} reply="${reply}"`);
    }
  },

  async bug3a() {
    // A QUESTION about out-of-hours is not an emergency.
    await reset();
    const { transcript } = await run(
      ["Hi, my boiler's broken", 'Do you do out-of-hours emergencies?'],
      { name: 'bug3a', quiet: true }
    );
    const reply = transcript[1].ellie;

    check('bug3a', 'answers accurately: no out-of-hours call-outs', /don'?t|do not|no,|not out of hours|monday to friday|eight till five|8 till 5/i.test(reply), reply);
    check('bug3a', 'does NOT read the gas safety script at them', !/open your windows|turn the gas off|get everyone out/i.test(reply), reply);
    check('bug3a', 'does NOT offer a booking', !BOOKING_OFFER.test(reply) && !TIME_OFFER.test(reply.replace(/eight till five|8 till 5/gi, '')), reply);
    check('bug3a', 'returns to diagnostics', /postcode|whereabouts|repair|service|what.*doing|make/i.test(reply), reply);

    const st = await stateOf();
    check('bug3a', 'does not flag an emergency for a mere question', !st || st.emergency === null, st && st.emergency);
  },

  async bug3b() {
    // A real gas emergency is a terminal branch.
    await reset();
    const { transcript } = await run(
      ['I can smell gas in the kitchen'],
      { name: 'bug3b', quiet: true }
    );
    const reply = transcript[0].ellie;

    check('bug3b', 'gives the safety script with 0800 111 999', SAFETY_SCRIPT.test(reply), reply);
    check('bug3b', 'tells them to get out / open windows', /open (the |your )?windows|get everyone out|get out of the house|don'?t touch/i.test(reply), reply);
    check('bug3b', 'does NOT offer a booking', !BOOKING_OFFER.test(reply) && !TIME_OFFER.test(reply), reply);
    check('bug3b', 'does not ask for the postcode instead of handling the emergency', !/give me the postcode/i.test(reply), reply);

    const st = await stateOf();
    check('bug3b', 'emergency recorded server-side', st && st.emergency !== null, st && JSON.stringify(st.emergency));

    // And booking must now be refused no matter what.
    const r = await fetch(`${BASE}/tools/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dayPreference: 'Wednesday' }),
    });
    const j = await r.json();
    check('bug3b', 'booking endpoints refuse for the rest of the call', j.ok === false && j.reason === 'emergency', JSON.stringify(j));
  },

  async outOfArea() {
    await reset();
    const { transcript, text } = await run(
      ["Hiya, boiler's not working", "It's EH1 1YZ, in Edinburgh", 'Oh right, thanks anyway.'],
      { name: 'outOfArea', quiet: true }
    );
    // Assert across the whole call, not one turn: she sometimes spends a turn
    // reading the postcode back before declining, which shifts every index.
    const reply = text;

    check('outOfArea', 'declines politely', /sorry|afraid|don'?t (get|cover)|not.*cover/i.test(reply), reply);
    check('outOfArea', 'points at the Gas Safe Register', /gas safe/i.test(reply), reply);
    check('outOfArea', 'does not keep taking details', !/what.*make|postcode again|full address|your name/i.test(reply), reply);
    check('outOfArea', 'offers no time', !TIME_OFFER.test(reply), reply);

    const st = await stateOf();
    check('outOfArea', 'gate A stays shut', !st || st.gate.A === false, st && JSON.stringify(st.gate));
  },

  async pushy() {
    await reset();
    const { transcript } = await run(
      ['Just book me in for tomorrow, I don\'t know anything about the boiler',
       "It's M20 2RT, 14 Oak Road",
       "It's a gas boiler. My own place.",
       "I told you, I don't know. It's a repair, it's just not firing up.",
       'No idea on the make. No code. Nothing else.'],
      { name: 'pushy', quiet: true }
    );

    const first = transcript[0].ellie;
    check('pushy', 'does not jump to booking when pushed', !TIME_OFFER.test(first), first);
    // Across the opening exchanges, not one turn: she sometimes acknowledges the
    // push in its own turn before asking, which is good behaviour, not a failure.
    const opening = transcript.slice(0, 2).map((t) => t.ellie).join(' ');
    check('pushy', 'asks the next outstanding question instead', /postcode|whereabouts|where.*property/i.test(opening), opening);

    const st = await stateOf();
    if (st) {
      check('pushy', 'records "not given" rather than inventing a make', !st.diagnostics.makeModel || /not given|no idea|don'?t know/i.test(st.diagnostics.makeModel), st.diagnostics.makeModel);
      check('pushy', 'both gates eventually close', st.gate.A === true && st.gate.B === true, JSON.stringify({ gate: st.gate, diagnostics: st.diagnostics }));
    }
  },

  async mishearing() {
    await reset();
    const { transcript } = await run(
      ["Boiler's leaking", 'It\'s em twenty something, I can\'t remember exactly'],
      { name: 'mishearing', quiet: true }
    );
    const reply = transcript[1].ellie;
    check('mishearing', 're-asks rather than guessing a postcode', /again|repeat|letter by letter|didn'?t (quite )?catch|sorry/i.test(reply), reply);

    const st = await stateOf();
    check('mishearing', 'does not mark an unheard postcode as in-area', !st || st.location.inArea !== true, st && JSON.stringify(st.location));
  },

  async happyPath() {
    await reset();
    const { transcript } = await runAdaptive(
      [
        { match: /postcode|whereabouts|where.*propert/i, reply: "It's M20 2RT." },
        // `exclude` matters here: she says "your email address?", which would
        // otherwise match the address rule and loop the caller forever.
        { match: /address|house number|street/i, exclude: /e-?mail/i, reply: '14 Oak Road, Didsbury.' },
        { match: /what have you got|gas boiler.*something else|what.*system/i, reply: "It's a Worcester Bosch gas combi." },
        { match: /own place|tenant|landlord|calling as/i, reply: "It's my own place." },
        { match: /broken|repair.*service|service.*repair|new boiler|kind of job/i, reply: "It's broken — a repair." },
        { match: /heating.*(alright|too|still)|radiators/i, reply: "The heating's still working fine, it's just the hot water." },
        // Answers make AND code together — she often asks for both in one breath,
        // and a fixed answer to only the first half loses the code entirely.
        { match: /make|worcester.*baxi|manufacturer/i, reply: "It's a Worcester Bosch combi, and there's a code showing on the display — F28." },
        { match: /code|gc number|display/i, reply: "The code is F28." },
        { match: /anything else|noticed|water underneath|warning light|pilot/i, reply: "There's water underneath it, yes. Nothing else." },
        // The repair lane asks two more than the old flow did.
        { match: /how long|constant|come and go|intermittent/i, reply: 'Since yesterday morning, and it\'s been constant.' },
        { match: /anyone else|looked at it|been out to it|had it looked/i, reply: "No, nobody else has touched it." },
        { match: /what day|day suits|morning or afternoon/i, reply: 'Wednesday morning would be good.' },
        { match: /any of those|any good|which.*suit|I can do/i, reply: 'The first one please.' },
        { match: /full name|your name/i, reply: 'James Whitfield.' },
        { match: /number|contact/i, reply: "It's 07986 321440." },
        { match: /email|spell/i, reply: 'J - W - H - I - T - F - I - E - L - D at gmail dot com' },
        { match: /all correct|got all that|is that right|check I'?ve got/i, reply: "Yes, that's all correct, go ahead and book it." },
      ],
      {
        name: 'happyPath',
        opener: "Hiya, I've got no hot water at all.",
        quiet: true,
        maxTurns: 28,
        // Stop as soon as the booking really exists, rather than guessing turn count.
        done: async () => {
          const st = await stateOf();
          return Boolean(st && st.bookingUid);
        },
      }
    );

    const all = transcript.map((t) => t.ellie).join('\n');
    const st = await stateOf();

    check('happyPath', 'both gates closed', st && st.gate.A && st.gate.B, st && JSON.stringify(st.gate));
    check('happyPath', 'captured the real fault, not an invented one', st && /hot water/i.test(st.diagnostics.fault || ''), st && st.diagnostics.fault);
    check('happyPath', 'captured the make the caller actually said', st && /worcester/i.test(st.diagnostics.makeModel || ''), st && st.diagnostics.makeModel);
    check('happyPath', 'captured the code F28', st && /f\s*28/i.test(st.diagnostics.gcOrErrCode || st.diagnostics.symptoms || ''), st && st.diagnostics.gcOrErrCode);
    check('happyPath', 'a booking was created', Boolean(st && st.bookingUid), st && st.bookingUid);
    check('happyPath', 'never spoke a raw timestamp', !/\d{4}-\d{2}-\d{2}T/.test(all));
    check('happyPath', 'never spoke a booking uid', !st || !st.bookingUid || !all.includes(st.bookingUid));

    if (st && st.bookingUid) {
      // Cal.com's booking list is eventually consistent — a brand-new booking
      // takes a second or two to appear. Poll rather than accuse it of failing.
      let mine = null;
      for (let i = 0; i < 6 && !mine; i++) {
        const b = await cal.getBookings({ status: 'upcoming', take: '50' });
        const rows = Array.isArray(b.json.data) ? b.json.data : [];
        mine = rows.find((x) => x.uid === st.bookingUid);
        if (!mine) await new Promise((r) => setTimeout(r, 1500));
      }
      check('happyPath', 'booking is really in the Cal.com diary', Boolean(mine), st.bookingUid);
      if (mine) {
        const mins = (new Date(mine.end) - new Date(mine.start)) / 60000;
        check('happyPath', 'booked as a 120-minute attendance window', mins === 120, `${mins}min`);
        const desc = JSON.stringify(mine);
        check('happyPath', 'engineer notes carry the fault and the make', /worcester/i.test(desc) && /hot water/i.test(desc), desc.slice(0, 200));
      }
      await cal.cancelBooking(st.bookingUid, 'Automated scenario cleanup');
      console.log('          (test booking cancelled)');
    }
  },

  /**
   * Someone ringing back to move a visit. Gate B is skipped — they've already been
   * diagnosed — but the name must be confirmed before anything changes, and the
   * name on the booking must never be spoken first.
   */
  async moveAndCancel() {
    await reset();

    // Put a real booking in the diary for them to ring about.
    const state = require('../src/state');
    const tools = require('../src/tools');
    const setup = state.get('setup-move', '+447700900123');
    Object.assign(setup.location, { addressLine1: '9 Elm Grove', addressExtra: 'Sale', postcode: 'M33 1AA', inArea: true });
    setup.systemCovered = true; setup.systemType = 'Baxi gas combi';
    setup.callerRelationship = 'owner'; setup.lane = 'repair';
    Object.assign(setup.diagnostics, { issueType: 'repair', fault: 'boiler cutting out', makeModel: 'Baxi', symptoms: 'not given' });
    Object.assign(setup.contact, { name: 'Margaret Hollis', phone: '07700 900123', email: 'manyamsoumithreddy@gmail.com' });

    const av = await tools.checkAvailability(setup, { dayPreference: 'Thursday', timePreference: 'any' });
    if (!av.ok || !av.slots.length) return check('moveAndCancel', 'could seed a booking', false, JSON.stringify(av));
    const seeded = await tools.bookAppointment(setup, { chosenSlotLabel: av.slots[0].label });
    if (!seeded.ok) return check('moveAndCancel', 'could seed a booking', false, JSON.stringify(seeded));
    const originalUid = setup.bookingUid;
    console.log(`          (seeded ${av.slots[0].label} for Margaret Hollis)`);

    try {
      const { transcript } = await run(
        [
          'Hello, I need to move my appointment. My number is 07700 900123.',
          'Sarah Connor',
        ],
        { name: 'moveAndCancel', quiet: true }
      );

      const findReply = transcript[0].ellie;
      check('moveAndCancel', 'finds the booking and states the date and time', /thursday|\d\s*(am|pm)/i.test(findReply), findReply);
      check('moveAndCancel', 'does NOT volunteer the name on the booking', !/margaret|hollis/i.test(findReply), findReply);
      check('moveAndCancel', 'asks the caller to confirm the name', /name/i.test(findReply), findReply);

      const mismatchReply = transcript[1].ellie;
      check('moveAndCancel', 'a wrong name never reveals the real one', !/margaret|hollis/i.test(mismatchReply), mismatchReply);
      check('moveAndCancel', 'a wrong name is refused and sent to the office', /office|0000 000 0000|not the name/i.test(mismatchReply), mismatchReply);

      // The booking must be untouched after a failed identity check.
      const list = await cal.getBookings({ status: 'upcoming', take: '50' });
      const rows = Array.isArray(list.json.data) ? list.json.data : [];
      const still = rows.find((b) => b.uid === originalUid);
      check('moveAndCancel', 'the booking is unchanged after a failed name check', Boolean(still), originalUid);
    } finally {
      await cal.cancelBooking(originalUid, 'Automated scenario cleanup');
      console.log('          (seeded booking cancelled)');
    }
  },

/* ---------------------------------------------------------- the new lanes */

  /** A service caller must never be asked what fault their boiler has. */
  async serviceLane() {
    await reset();
    const { text, transcript } = await run(
      [
        "Hiya, I need to book my annual boiler service.",
        "It's M20 2RT.",
        '14 Oak Road.',
        "It's a Worcester gas combi.",
        "It's my own house.",
        'Just a service. Only the boiler, nothing else.',
        'It was about a year ago, you did it.',
      ],
      { name: 'serviceLane', quiet: true }
    );

    check('serviceLane', 'never asks what the fault is',
      !/what.*(it|boiler).*(doing|wrong)|what'?s the fault|radiators cold|error code|pilot light/i.test(text), text.slice(0, 200));
    check('serviceLane', 'asks service or certificate',
      /service.*certificate|certificate.*service/i.test(text), text.slice(0, 200));

    const st = await stateOf();
    if (st) {
      check('serviceLane', 'lane recorded as service', st.lane === 'service', st.lane);
      check('serviceLane', 'gate B opens with no fault answers', st.gate.B === true, JSON.stringify(st.diagnostics));
      check('serviceLane', 'no fault was invented', !st.diagnostics.fault, st.diagnostics.fault);
    }
  },

  /** A new boiler ends in a survey, and never in a price. */
  async newBoilerLane() {
    await reset();
    const { text } = await run(
      [
        "I'm after a price for a new boiler.",
        "M20 2RT.",
        '14 Oak Road.',
        "It's a gas combi at the moment.",
        'I own it.',
        "It still works, it's just old. A back boiler, about 20 years old.",
        'Three bedrooms and one bathroom.',
        'So how much am I looking at?',
      ],
      { name: 'newBoilerLane', quiet: true }
    );

    check('newBoilerLane', 'never quotes a price',
      !/£|\bpound|\bcost you\b|roughly \d{3,}|around \d{3,}/i.test(text), text.slice(-260));
    check('newBoilerLane', 'explains the surveyor prices it',
      /surveyor|survey|fixed price|come out and/i.test(text), text.slice(-260));
    check('newBoilerLane', 'no charge / no obligation is offered',
      /no charge|no obligation|free/i.test(text), text.slice(-260));

    const st = await stateOf();
    if (st) check('newBoilerLane', 'lane recorded as newBoiler', st.lane === 'newBoiler', st.lane);
  },

  /** Something we don't cover is declined BEFORE any details are taken. */
  async notOurTrade() {
    await reset();
    // Adaptive: the flow checks the area before the system, so she asks for the
    // postcode and address first. A fixed script runs out of turns before she
    // ever reaches the question that declines the job.
    const { text } = await runAdaptive(
      [
        { match: /postcode|whereabouts|where.*propert/i, reply: "It's M20 2RT." },
        { match: /address|house number|street/i, exclude: /e-?mail/i, reply: '14 Oak Road.' },
        { match: /what have you got|gas boiler|something else|what.*system/i, reply: "It's air conditioning — a wall unit." },
      ],
      {
        name: 'notOurTrade',
        opener: 'Hi, my air conditioning has stopped working.',
        quiet: true,
        maxTurns: 8,
        done: async () => {
          const st = await stateOf();
          return Boolean(st && st.systemCovered === false);
        },
      }
    );

    check('notOurTrade', 'declines the job', /don'?t cover|not something we cover|can'?t help|afraid/i.test(text), text.slice(0, 260));
    check('notOurTrade', 'names the right trade', /refrigeration|air con/i.test(text), text.slice(0, 260));
    check('notOurTrade', 'never asks a fault question',
      !/what.*doing|error code|pilot light|what make/i.test(text), text);
    check('notOurTrade', 'offers no appointment', !TIME_OFFER.test(text), text.slice(-200));

    const st = await stateOf();
    if (st) {
      check('notOurTrade', 'system marked not covered', st.systemCovered === false, String(st.systemCovered));
      check('notOurTrade', 'gate B stays shut', st.gate.B === false, JSON.stringify(st.gate));
    }
  },

  /** No live tracking exists, so an ETA must never be invented. */
  async engineerEta() {
    await reset();
    const { text } = await run(
      ["Hi, where's the engineer? He was supposed to be here this morning.", 'My number is 07700 900123.'],
      { name: 'engineerEta', quiet: true }
    );

    check('engineerEta', 'never guesses an arrival time',
      !/should be with you|on his way|about \d+ minutes|within the hour|shortly after/i.test(text), text.slice(0, 300));
    check('engineerEta', 'offers an office callback', /ring you|call you|get back to you|office/i.test(text), text.slice(0, 300));
    check('engineerEta', 'does not book a new visit', !TIME_OFFER.test(text), text.slice(0, 300));
  },

  async dontKnow() {
    await reset();
    const { transcript } = await run(
      [
        "No heating. It's M20 2RT, 14 Oak Road.",
        "It's a gas boiler, and it's my own place.",
        "It's a repair, radiators are all cold.",
        'No idea what make it is.',
        "Can't see any code, no.",
        "Nothing else I've noticed.",
      ],
      { name: 'dontKnow', quiet: true }
    );
    const st = await stateOf();
    check('dontKnow', 'gate B closes on "not given" answers', st && st.gate.B === true, st && JSON.stringify(st.diagnostics));
    check('dontKnow', 'did not invent a make', !st || !/worcester|baxi|vaillant|ideal|glow/i.test(st.diagnostics.makeModel || ''), st && st.diagnostics.makeModel);
    const last = transcript[transcript.length - 1].ellie;
    check('dontKnow', 'moves on to booking once all four are answered', TIME_OFFER.test(last) || /what day|day suits|morning or afternoon/i.test(last), last);
  },
};

/* ---------------------------------------------------------------------- run */

(async () => {
  if (!BASE) throw new Error('PUBLIC_BASE_URL not set');
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(SCENARIOS);

  for (const name of names) {
    if (!SCENARIOS[name]) { console.error(`unknown scenario: ${name}`); continue; }
    console.log(`\n${name}`);
    try {
      await reset();
      await SCENARIOS[name]();
    } catch (err) {
      check(name, 'scenario ran without throwing', false, err.message);
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  ${f.scenario}: ${f.label}`);
  }
  process.exit(failed.length ? 1 : 0);
})();
