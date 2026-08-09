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
  newboiler: 'New boiler survey',
  survey: 'New boiler survey',
  landlord_cert: 'Landlord certificate',
  certificate: 'Landlord certificate',
};

/** The lane decides the heading when the caller never named an issue type. */
const LANE_LABELS = {
  repair: 'Repair',
  service: 'Service',
  newBoiler: 'New boiler survey',
};

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^not given$/i.test(s)) return null;
  return s;
}

function build(state) {
  const d = state.diagnostics;
  const issue = clean(d.issueType) || clean(d.serviceType);
  const issueLabel = issue
    ? ISSUE_LABELS[issue.toLowerCase().replace(/[^a-z_]/g, '')] || issue
    : (LANE_LABELS[state.lane] || 'Job');

  const faultBits = [clean(d.fault), clean(d.probeAnswer)].filter(Boolean);
  const line1 = [
    faultBits.length ? `${issueLabel} — ${faultBits.join(', ')}` : issueLabel,
    clean(d.applianceCount),
    clean(d.currentSystem),
    clean(d.bedrooms) ? `${clean(d.bedrooms)} bed` : null,
    clean(d.makeModel),
    clean(d.gcOrErrCode) ? `code ${clean(d.gcOrErrCode)}` : null,
    clean(d.symptoms),
    clean(state.callerRelationship) && state.callerRelationship !== 'owner'
      ? `caller: ${clean(state.callerRelationship)}` : null,
  ].filter(Boolean).join(' | ');

  const line2 = [
    [
      clean(state.location.addressLine1),
      clean(state.location.addressExtra),
      clean(state.location.postcode),
    ].filter(Boolean).join(', '),
    clean(state.contact.phone),
  ].filter(Boolean).join(' | ');

  return [line1, line2].filter(Boolean).join('\n');
}

module.exports = { build };
