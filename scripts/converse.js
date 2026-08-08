'use strict';

/**
 * Drives a scripted conversation against the live assistant.
 *
 * Tools execute for real, so this exercises the whole chain — prompt, Telnyx,
 * middleware, gates, Cal.com — without needing a phone number.
 *
 *   node scripts/converse.js "I've no hot water" "M20 2RT" "14 Oak Road"
 */

require('dotenv').config();

const KEY = process.env.TELNYX_API_KEY;
const ASSISTANT = process.env.TELNYX_ASSISTANT_ID;

async function tx(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.telnyx.com/v2${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function newConversation(name = 'test') {
  const r = await tx('/ai/conversations', {
    method: 'POST',
    body: { name, metadata: { assistant_id: ASSISTANT } },
  });
  if (!r.ok) throw new Error(`could not create conversation: ${JSON.stringify(r.json)}`);
  return r.json.data.id;
}

async function say(conversationId, content) {
  const r = await tx(`/ai/assistants/${ASSISTANT}/chat`, {
    method: 'POST',
    body: { content, conversation_id: conversationId },
  });
  if (!r.ok) return `[error ${r.status}] ${JSON.stringify(r.json).slice(0, 200)}`;
  return (r.json && r.json.content) || '[no content]';
}

/** Run a list of caller turns, returning the full transcript. */
async function run(turns, { name = 'test', quiet = false } = {}) {
  const conversationId = await newConversation(name);
  const transcript = [];
  for (const turn of turns) {
    const reply = await say(conversationId, turn);
    transcript.push({ caller: turn, ellie: reply });
    if (!quiet) {
      console.log(`\n  caller > ${turn}`);
      console.log(`  Ellie  > ${reply}`);
    }
  }
  return { conversationId, transcript, text: transcript.map((t) => t.ellie).join('\n') };
}

/**
 * A caller who answers whatever was actually asked.
 *
 * A fixed list of turns drifts the moment the assistant does something reasonable
 * but unscripted — most often spending a turn on "let me have a look at the diary"
 * before the slots arrive. Every later answer then lands on the wrong question and
 * the run fails for no real reason. This replies based on what was said instead.
 *
 * @param {Array<{match: RegExp, reply: string, once?: boolean}>} answers
 */
async function runAdaptive(answers, { name = 'test', maxTurns = 18, opener, quiet = false, done } = {}) {
  const conversationId = await newConversation(name);
  const transcript = [];
  const used = new Set();

  let next = opener;
  for (let i = 0; i < maxTurns && next !== null; i++) {
    const reply = await say(conversationId, next);
    transcript.push({ caller: next, ellie: reply });
    if (!quiet) {
      console.log(`  caller > ${next}`);
      console.log(`  Ellie  > ${reply.replace(/\n+/g, ' ')}\n`);
    }

    if (done && (await done(transcript))) break;

    const candidate = answers.find(
      (a, idx) => a.match.test(reply) && !(a.once && used.has(idx))
    );
    if (candidate) {
      used.add(answers.indexOf(candidate));
      next = candidate.reply;
    } else {
      // She's said something that isn't a question — a filler line, or a
      // confirmation. Nudge gently rather than answering a question she never asked.
      next = /\?/.test(reply) ? "Yes, that's right." : 'Right, thanks.';
    }
  }

  return { conversationId, transcript, text: transcript.map((t) => t.ellie).join('\n') };
}

module.exports = { run, runAdaptive, say, newConversation };

if (require.main === module) {
  const turns = process.argv.slice(2);
  if (!turns.length) {
    console.error('usage: node scripts/converse.js "first thing" "second thing" ...');
    process.exit(1);
  }
  run(turns, { name: 'manual' }).then(({ conversationId }) => {
    console.log(`\n  (conversation ${conversationId})`);
  });
}
