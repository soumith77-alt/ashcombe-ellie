'use strict';

/**
 * Lesson 2 from the previous build: a tool named one thing in the config and
 * another in the prompt silently breaks invocation — no error, the model just
 * never calls it. This diffs the three places a name has to agree:
 *
 *   the prompt  <->  the tools attached to the assistant  <->  the Express routes
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const KEY = process.env.TELNYX_API_KEY;
const ASSISTANT_ID = process.env.TELNYX_ASSISTANT_ID;

(async () => {
  const instructions = fs.readFileSync(path.join(__dirname, '..', 'docs', 'instructions.md'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  const res = await fetch(`https://api.telnyx.com/v2/ai/assistants/${ASSISTANT_ID}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const a = await res.json();
  const attached = (a.tools || []).map((t) => (t.webhook && t.webhook.name) || t.display_name).filter(Boolean);

  // Names the prompt actually asks the model to call, written as `tool_name`.
  const inPrompt = [...new Set(
    (instructions.match(/`([a-z_]+)`/g) || [])
      .map((m) => m.replace(/`/g, ''))
      .filter((n) => n.includes('_'))
  )];

  const routed = (server.match(/tool\('([a-z_]+)'/g) || []).map((m) => m.match(/'([a-z_]+)'/)[1]);

  console.log(`assistant : ${ASSISTANT_ID}`);
  console.log(`model     : ${a.model}`);
  console.log(`attached  : ${attached.length} tools`);
  console.log(`routed    : ${routed.length} express handlers`);
  console.log(`in prompt : ${inPrompt.length} referenced\n`);

  let bad = 0;

  for (const n of inPrompt) {
    if (!attached.includes(n)) {
      console.error(`  FAIL  prompt calls "${n}" but no such tool is attached`);
      bad++;
    }
  }
  for (const n of attached) {
    if (!routed.includes(n)) {
      console.error(`  FAIL  tool "${n}" is attached but has no Express route`);
      bad++;
    }
    if (!inPrompt.includes(n)) {
      console.warn(`  warn  tool "${n}" is attached but the prompt never mentions it`);
    }
  }

  // The Cal.com key must never be reachable from the assistant config.
  const dump = JSON.stringify(a);
  if (dump.includes('cal_live_')) {
    console.error('  FAIL  the Cal.com API key is present in the assistant config');
    bad++;
  }

  console.log(bad === 0 ? '\nOK — every name agrees, no secrets in the assistant.' : `\n${bad} problem(s).`);
  process.exit(bad === 0 ? 0 : 1);
})();
