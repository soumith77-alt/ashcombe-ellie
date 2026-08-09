'use strict';

/**
 * Generates spoken samples of Ellie's actual lines so a voice can be chosen by ear
 * rather than from a catalogue description.
 *
 * The sample line is deliberately a real one from the call — a greeting, a
 * reassurance, and a slot offer — because that's where a voice either sounds like a
 * receptionist or like a phone menu. Numbers and postcodes are the hard part for
 * TTS, so they're in there too.
 *
 *   node scripts/audition-voices.js
 *   open audio/                       # then listen
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const KEY = process.env.TELNYX_API_KEY;
const OUT = path.join(__dirname, '..', 'audio');

const LINE =
  "Good morning, Ashcombe Heating, Ellie speaking — how can I help? " +
  "Right, no hot water at all, that's miserable in this weather. " +
  "Grand, we cover you there. " +
  "I can do Wednesday the twelfth at nine, or Thursday first thing. Any of those any good?";

/**
 * The shortlist. Skipped: "Charlotte - Heiress" (narration, too posh for a heating
 * office), "Evie - Engaging Expert" (formal corporate), and "Evelyn - Digital
 * Assistante" whose own description promises "digital polish" — the opposite of
 * sounding like a person.
 */
const CANDIDATES = [
  ['ailsa-warm-guide',            'Telnyx.Ultra.fb02b554-7d64-4f90-841e-e57fc88f410c', 'CURRENT — calm, personable'],
  ['lucy-capable-coordinator',    'Telnyx.Ultra.2f251ac3-89a9-4a77-a452-704b474ccd01', 'reassuring, customer assistance'],
  ['saira-organized-coordinator', 'Telnyx.Ultra.1e9b9b3d-d2ce-4cac-9d05-bc36a63fa28e', 'warm, attentive'],
  ['pippa-bright-assistant',      'Telnyx.Ultra.81cd8d19-45e7-47b2-ad0e-bcd94f557ad0', 'bright, upbeat'],
  ['gemma-decisive-agent',        'Telnyx.Ultra.62ae83ad-4f6a-430b-af41-a9bede9286ca', 'confident, emotive'],
  ['imogen-polished-guide',       'Telnyx.Ultra.5a93ae96-9e3e-4b9d-8575-5f62b7de6d0f', 'polished, articulate'],
  ['victoria-refined',            'Telnyx.Ultra.dc30854e-e398-4579-9dc8-16f6cb2c19b9', 'crisp, professional'],
  ['fiona-witty-woman',           'Telnyx.Ultra.a01c369f-6d2d-4185-bc20-b32c225eab70', 'chirpy, energetic'],
];

async function speak(voice, file) {
  const res = await fetch('https://api.telnyx.com/v2/text-to-speech/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: LINE, voice }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return { ok: true, bytes: buf.length };
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  console.log(`Auditioning ${CANDIDATES.length} British female voices\n`);

  for (const [slug, voice, note] of CANDIDATES) {
    const file = path.join(OUT, `${slug}.mp3`);
    const r = await speak(voice, file);
    console.log(
      r.ok
        ? `  ${slug.padEnd(30)} ${String(Math.round(r.bytes / 1024)).padStart(3)} KB   ${note}`
        : `  ${slug.padEnd(30)} FAILED (${r.status})`
    );
  }

  fs.writeFileSync(
    path.join(OUT, 'voice-ids.txt'),
    CANDIDATES.map(([s, v, n]) => `${s}\n  ${v}\n  ${n}\n`).join('\n')
  );
  console.log(`\nWritten to ${OUT}`);
  console.log('Listen, then put the chosen id in scripts/setup-telnyx.js (voice_settings.voice)');
  console.log('and re-run: npm run setup:telnyx');
})();
