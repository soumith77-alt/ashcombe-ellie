'use strict';

const business = require('../config/business.json');
const jobDescription = require('./jobDescription');

/**
 * The confirmation emails.
 *
 * Ellie tells every caller "you'll get a confirmation email in the next few
 * minutes". Until this existed that was simply untrue — Cal.com sends nothing for
 * this account, verified by booking with a plus-address and finding no mail in the
 * inbox, spam or trash. An agent that promises something the system doesn't do is
 * worse than one that stays quiet.
 *
 * Two emails per booking:
 *   customer — what's booked, where, and what happens next
 *   manager  — the same plus the engineer's job line, so the office can plan
 *
 * SENDING NEVER BLOCKS A CALL. Same rule as the sheet: queued, retried, and
 * abandoned after three attempts rather than holding a caller in silence. A
 * booking that exists without its email is a nuisance; a caller listening to dead
 * air because an SMTP server was slow is a lost customer.
 */

let transport = null;
let enabled = null;

function config() {
  return {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
    manager: process.env.MANAGER_EMAIL,
  };
}

function isEnabled() {
  if (enabled === null) {
    const c = config();
    enabled = Boolean(c.user && c.pass);
    if (!enabled) console.log('[email] disabled (GMAIL_USER / GMAIL_APP_PASSWORD not set)');
  }
  return enabled;
}

function mailer() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  const c = config();
  transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: c.user, pass: c.pass },
  });
  return transport;
}

/* ------------------------------------------------------------------ content */

const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function addressOf(state) {
  return [state.location.addressLine1, state.location.postcode].filter(Boolean).join(', ');
}

/** What the visit is called in plain English, per lane. */
const VISIT = {
  repair: 'engineer visit',
  service: 'service visit',
  newBoiler: 'free survey',
};

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f6f1ea;padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1512">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ece5dc;border-radius:14px;overflow:hidden">
      <div style="background:linear-gradient(150deg,#f5a03c,#c2570a);padding:18px 24px;color:#fff">
        <div style="font-size:17px;font-weight:600">${esc(business.businessName)}</div>
        <div style="font-size:12px;opacity:.9">Gas Safe registered · ${esc(business.bookingHours ? 'Mon–Fri 08:00–17:00' : '')}</div>
      </div>
      <div style="padding:24px">
        <h1 style="margin:0 0 14px;font-size:19px">${esc(title)}</h1>
        ${bodyHtml}
      </div>
      <div style="padding:14px 24px;border-top:1px solid #ece5dc;font-size:12px;color:#857a72">
        Questions? Ring the office on ${esc(business.officePhone)}.
      </div>
    </div></body></html>`;
}

function row(label, value) {
  if (!value) return '';
  return `<tr><td style="padding:6px 12px 6px 0;color:#857a72;font-size:13px;vertical-align:top">${esc(label)}</td>
    <td style="padding:6px 0;font-size:14px">${esc(value)}</td></tr>`;
}

function customerEmail(state, label) {
  const visit = VISIT[state.lane] || 'engineer visit';
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
      Thanks for calling. Your ${esc(visit)} is booked in.</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:18px">
      ${row('When', label)}
      ${row('Where', addressOf(state))}
      ${row('Name', state.contact.name)}
    </table>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#5f564f">
      The office will ring you nearer the time to confirm which engineer is coming and
      the arrival window. The time above is when we've booked you in, not a guaranteed
      arrival time.</p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#5f564f">
      Need to change it? Just ring the office on ${esc(business.officePhone)}.</p>`;
  return {
    subject: `Your ${visit} — ${label}`,
    html: shell(`You're booked in for ${label}`, body),
  };
}

function managerEmail(state, label, kind) {
  const visit = VISIT[state.lane] || 'engineer visit';
  const heading = kind === 'booked'
    ? `New ${visit} booked`
    : kind === 'rescheduled' ? `${visit} moved` : `${visit} cancelled`;

  const notes = jobDescription.build(state);
  const body = `
    <table style="border-collapse:collapse;width:100%;margin-bottom:18px">
      ${row('When', label)}
      ${row('Customer', state.contact.name)}
      ${row('Phone', state.contact.phone)}
      ${row('Email', state.contact.email)}
      ${row('Address', addressOf(state))}
      ${row('Calling as', state.callerRelationship)}
      ${row('System', state.systemType)}
    </table>
    <div style="background:#fff3e4;border:1px solid rgba(194,87,10,.24);border-radius:10px;padding:12px 14px">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9a4406;margin-bottom:6px">
        For the engineer</div>
      <pre style="margin:0;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.55;
        white-space:pre-wrap;color:#1a1512">${esc(notes)}</pre>
    </div>
    <p style="margin:16px 0 0;font-size:12px;color:#857a72">Booked by Ellie on the phones.</p>`;
  return { subject: `${heading} — ${state.contact.name || 'customer'}, ${label}`, subject_: null, html: shell(heading, body) };
}

/**
 * The one email that matters more than the confirmations.
 *
 * Ellie has just told a caller to ring the office. Most won't. This is the only
 * thing standing between that and a customer nobody knows existed — so it carries
 * everything needed to ring them back without asking a single question again.
 * Manager only: the customer has already been told, and "your booking failed" in
 * writing helps nobody.
 */
function lostBookingEmail(state, label, reason) {
  const visit = VISIT[state.lane] || 'engineer visit';
  const body = `
    <div style="background:#fdecec;border:1px solid rgba(180,35,35,.28);border-radius:10px;
      padding:12px 14px;margin-bottom:18px">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#a11b1b;margin-bottom:6px">
        Ring this customer back</div>
      <div style="font-size:14px;line-height:1.55">They asked for a ${esc(visit)} and Ellie
        couldn't get it into the diary, so they were asked to ring the office. Assume they won't.</div>
    </div>
    <table style="border-collapse:collapse;width:100%;margin-bottom:18px">
      ${row('Wanted', label)}
      ${row('Customer', state.contact.name)}
      ${row('Phone', state.contact.phone || state.callerNumber)}
      ${row('Email', state.contact.email)}
      ${row('Address', addressOf(state))}
      ${row('Calling as', state.callerRelationship)}
      ${row('System', state.systemType)}
      ${row('What went wrong', reason)}
    </table>
    <div style="background:#fff3e4;border:1px solid rgba(194,87,10,.24);border-radius:10px;padding:12px 14px">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9a4406;margin-bottom:6px">
        What they told us</div>
      <pre style="margin:0;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.55;
        white-space:pre-wrap;color:#1a1512">${esc(jobDescription.build(state))}</pre>
    </div>`;
  const who = state.contact.name || state.contact.phone || state.callerNumber || 'a caller';
  return {
    subject: `NOT BOOKED — ring ${who} back${label ? ` (wanted ${label})` : ''}`,
    html: shell('A booking didn’t go through', body),
  };
}

/* -------------------------------------------------------------- the queue */

const queue = [];
let flushing = false;

function enqueue(job) {
  if (!isEnabled()) return;
  if (!job.to) return;
  queue.push({ ...job, attempts: 0 });
  setImmediate(flush);
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const job = queue[0];
      try {
        await mailer().sendMail({
          from: `"${business.businessName}" <${config().user}>`,
          to: job.to,
          subject: job.subject,
          html: job.html,
        });
        queue.shift();
      } catch (err) {
        job.attempts += 1;
        console.error(`[email] to ${job.to} failed (attempt ${job.attempts}):`, err.message);
        if (job.attempts >= 3) {
          queue.shift();
          console.error('[email] giving up on', job.subject);
        } else {
          await new Promise((r) => setTimeout(r, 1000 * job.attempts));
        }
      }
    }
  } finally {
    flushing = false;
  }
}

/* --------------------------------------------------------------- public */

function sendBooked(state, label) {
  const c = customerEmail(state, label);
  enqueue({ to: state.contact.email, subject: c.subject, html: c.html });
  const m = managerEmail(state, label, 'booked');
  enqueue({ to: config().manager, subject: m.subject, html: m.html });
}

function sendBookingFailed(state, label, reason) {
  const m = lostBookingEmail(state, label, reason);
  enqueue({ to: config().manager, subject: m.subject, html: m.html });
}

function sendChanged(state, label, kind) {
  const m = managerEmail(state, label, kind);
  enqueue({ to: config().manager, subject: m.subject, html: m.html });
  if (state.contact.email) {
    const moved = kind === 'rescheduled';
    enqueue({
      to: state.contact.email,
      subject: moved ? `Your visit has moved — ${label}` : 'Your visit has been cancelled',
      html: shell(
        moved ? `Your visit has moved to ${label}` : 'Your visit has been cancelled',
        moved
          ? `<p style="font-size:15px;line-height:1.6">That's been moved for you. The office will ring nearer
             the time to confirm the engineer and the arrival window.</p>`
          : `<p style="font-size:15px;line-height:1.6">That's cancelled — nothing more to do. Ring the office on
             ${esc(business.officePhone)} whenever you'd like to rebook.</p>`
      ),
    });
  }
}

/** Used by the setup script to prove the credentials work before a real call does. */
async function verify() {
  if (!isEnabled()) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  await mailer().verify();
  return true;
}

module.exports = { isEnabled, verify, sendBooked, sendBookingFailed, sendChanged, flush, _queue: queue };
