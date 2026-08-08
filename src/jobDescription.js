'use strict';

/**
 * The engineer's job line, built server-side in a fixed order.
 *
 * Built here rather than by the assistant so it can't be reordered, embellished,
 * or invented. Only fields the caller actually gave appear; "not given" is dropped
 * rather than written out, because a blank tells the engineer more than a guess.
 */

const ISSUE_LABELS = {
  repair: 'Repair',
  service: 'Service',
  install: 'New install',
  landlord_cert: 'Landlord certificate',
};

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^not given$/i.test(s)) return null;
  return s;
}

function build(state) {
  const d = state.diagnostics;
  const issue = clean(d.issueType);
  const issueLabel = issue ? ISSUE_LABELS[issue.toLowerCase()] || issue : 'Job';

  const faultBits = [clean(d.fault), clean(d.probeAnswer)].filter(Boolean);
  const line1 = [
    faultBits.length ? `${issueLabel} — ${faultBits.join(', ')}` : issueLabel,
    clean(d.makeModel),
    clean(d.gcOrErrCode) ? `code ${clean(d.gcOrErrCode)}` : null,
    clean(d.symptoms),
  ].filter(Boolean).join(' | ');

  const line2 = [
    [clean(state.location.address), clean(state.location.postcode)].filter(Boolean).join(', '),
    clean(state.contact.phone),
  ].filter(Boolean).join(' | ');

  return [line1, line2].filter(Boolean).join('\n');
}

module.exports = { build };
