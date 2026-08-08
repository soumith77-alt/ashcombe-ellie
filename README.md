# Ellie — AI phone receptionist for Ashcombe Heating

Answers the phone, works out where the property is and what's wrong with the boiler,
then books an engineer into the Cal.com diary.

**Telnyx AI Assistant** (voice + LLM) → **this middleware** (state, gates, time) →
**Cal.com v2** (the engineers' diary).

---

## The one rule

Booking is locked until two gates open:

- **Gate A** — full address, postcode, and postcode confirmed inside the service area.
- **Gate B** — all four diagnostics answered: issue type, fault, make/model, symptoms.
  The literal string `"not given"` counts; a caller who doesn't know has still answered.

The gates are **computed server-side** in [src/state.js](src/state.js) and cannot be set
by the assistant. A prompt rule alone gets skipped under pressure — that's what caused
the bugs in the previous build. These are the backstops:

| Situation | What the middleware does |
|---|---|
| `check_availability` with a gate shut | Refuses and returns the next question. **Cal.com is never called.** |
| `book_appointment` with a missing contact field | Refuses and names the field. |
| `book_appointment` with a time not in `offeredSlots` | Refuses. This is what stops an invented time being booked. |
| Any booking call after an emergency | Refuses for the rest of the call. |
| A slot taken between offer and confirmation | Re-checks, refuses, offers another. No double booking. |

---

## Running it

```bash
npm install
cp .env.example .env          # then fill in the two API keys

npm run setup:calcom          # creates the London schedule + 120-min event type
cloudflared tunnel --url http://localhost:3000   # public URL for Telnyx to reach
# put the printed URL in PUBLIC_BASE_URL
npm run setup:telnyx          # creates the 10 shared tools + the assistant
node scripts/check-names.js   # tool names must agree across prompt/config/routes

npm start
```

Both setup scripts are idempotent — re-run them freely. `setup:telnyx` also updates the
assistant in place when `TELNYX_ASSISTANT_ID` is set, so editing
[docs/instructions.md](docs/instructions.md) and re-running is the normal edit loop.

**The tunnel URL changes each session.** After restarting it, update `PUBLIC_BASE_URL`
and re-run both setup scripts so the tool URLs and the Cal.com webhook follow.

## Testing

```bash
npm test                              # gates and refusals — no LLM, no network
node --test tests/live-calcom.test.js # real booking round trip + slot-taken race
node scripts/run-scenarios.js         # all ten scenarios against the live assistant
node scripts/run-scenarios.js bug1 bug2 bug3a bug3b   # just the regressions
```

Scenario runs book into the real diary and cancel after themselves.

## Where things live

| File | Why it exists |
|---|---|
| [src/state.js](src/state.js) | Per-call state. `gateA`/`gateB` are computed, never stored. |
| [src/tools/index.js](src/tools/index.js) | The ten tool handlers, and every refusal. |
| [src/calcom.js](src/calcom.js) | The only file holding the Cal.com key. Versions pinned per endpoint. |
| [src/time.js](src/time.js) | All `Europe/London` handling. Nothing else computes an offset. |
| [src/postcode.js](src/postcode.js) | in / out / unclear. Never guesses. |
| [config/service-area.json](config/service-area.json) | The patch. Edit this, not code. |
| [docs/instructions.md](docs/instructions.md) | The assistant's prompt — the actual product. |

---

## Things that cost time to find out

Verified against the live APIs. Each of these fails silently rather than loudly.

**Cal.com `cal-api-version` must be pinned per endpoint, not globally.**

```
/v2/slots       + 2024-09-04 → 200 with slots      (no header → 404)
/v2/bookings    + 2024-08-13 → 200 with real data
/v2/bookings    + 2024-06-14 → 200 with []          ← silently empty, no error
/v2/event-types + 2024-06-14 → 200
```

A single global constant makes find/reschedule/cancel return "no booking found"
forever, with nothing in the logs to explain it.

**Telnyx has no filler-message feature.** The brief assumed scripted filler at
0s/5s/10s/15s; there is no such field anywhere in the API. Silence is handled instead
by keeping every endpoint under ~2s, an `office` background audio bed, and the prompt
speaking its line before the tool call. `timeout_ms` also caps at **10 000 ms**, so a
30-second tool timeout isn't expressible.

**Telnyx sends no call identifier on webhook tool calls.** Not in the headers (only
`telnyx-signature-ed25519` and `telnyx-timestamp`), not in the body (only the model's
own parameters). Templated header values aren't resolved either —
`{{call_control_id}}` arrives with the braces intact. So the assistant carries the
reference itself from `{{call_control_id}}` in its instructions, as `conversationRef`.

This is the one place "never trust the model with an ID" can't be honoured — the
platform offers no alternative. The failure mode is made safe instead: a garbled
reference splits the state, the gates never close, and the middleware refuses to book.
A confused caller, never a phantom engineer visit.

**`{{telnyx_current_time}}` is UTC, not UK time.** The instructions use
`{{telnyx_current_time_Europe/London}}`. A relative date computed from a wrong "today"
is exactly the failure the brief warns about, and in summer it's an hour out.

**Inline `tools` on an assistant is deprecated** in favour of shared tools created at
`/ai/tools` and attached by `tool_ids`.

**Safety wording is returned by the tool, not left to the prompt.** A scenario run
caught the assistant flagging a gas emergency correctly and then skipping straight to
"shall the office ring you?" — no windows, no 0800 number. `flag_emergency` now returns
the script and the prompt reads it out. Same lesson as the booking gate.

---

## Known limits

- **No phone number.** The Telnyx account has none, and UK numbers need a UK
  proof-of-address document. Everything is verified through the text `/chat` endpoint
  with real tool execution; voice-only behaviour (barge-in, mishearing under real STT,
  how the audio bed feels) is untested until a number is attached.
- **Web chat has no `{{call_control_id}}`**, so chat conversations all key to `no-ref`.
  Fine for sequential testing; real voice calls always carry a distinct id.
- **`OFFICE_PHONE` is still `0000 000 0000`** in
  [config/business.json](config/business.json). Ellie reads it aloud to callers who are
  out of area, on an unclear postcode, or when a booking fails.
