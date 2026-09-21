/**
 * Unit checks for the missing-info follow-up engine (owner brief item 3,
 * handoffs/TECH_FOLLOWUPS_2026-09-21.md). Pure functions only — no DB, no
 * network, no Clerk.
 *
 *   node scripts/verify-followups.mjs
 */
import {
  FOLLOWUP_MAX_DOCS_PER_MESSAGE,
  FOLLOWUP_MAX_MESSAGES_PER_RUN,
  FOLLOWUP_DEBOUNCE_HOURS,
  FOLLOWUP_LAST_SENT_CAP,
  FOLLOWUP_INBOX_LINK,
  shapeFollowupSettings,
  shouldRunFollowups,
  technicianNameMatches,
  docTechnicianName,
  missingFieldsForDocument,
  missingFieldsPlainWords,
  memberForDocument,
  groupDocsByTechnician,
  selectGroupsForRun,
  renderFollowupMessage,
  canSendFollowup,
  recordFollowupSent,
} from '../api/_lib/followups.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- settings -- */

eq('default settings are off', shapeFollowupSettings(undefined), { enabled: false, email: false });
eq('a non-boolean enabled is coerced off', shapeFollowupSettings({ enabled: 'yes' }), { enabled: false, email: false });
eq('a real settings object round-trips', shapeFollowupSettings({ enabled: true, email: true }), { enabled: true, email: true });
check('shouldRunFollowups: disabled -> no-op', shouldRunFollowups({ enabled: false }) === false);
check('shouldRunFollowups: undefined settings -> no-op (default off)', shouldRunFollowups(undefined) === false);
check('shouldRunFollowups: enabled -> runs', shouldRunFollowups({ enabled: true }) === true);

/* -------------------------------------------------------- name matching -- */

check('exact match', technicianNameMatches('Dana Ramirez', 'Dana Ramirez'));
check('case-insensitive', technicianNameMatches('DANA RAMIREZ', 'dana ramirez'));
check('substring: display name inside a longer technician string', technicianNameMatches('Dana Ramirez - Lead Tech', 'Dana Ramirez'));
check('last-name-alone-as-a-word matches', technicianNameMatches('D. Ramirez', 'Dana Ramirez'));
check('first-name-alone does NOT match', !technicianNameMatches('Dana', 'Dana Ramirez'));
check('unrelated names do not match', !technicianNameMatches('Chris Nguyen', 'Dana Ramirez'));
check('empty technician name does not match', !technicianNameMatches('', 'Dana Ramirez'));
check('empty display name does not match', !technicianNameMatches('Dana Ramirez', ''));
check('null/undefined inputs do not match', !technicianNameMatches(null, undefined));

/* ------------------------------------------------------- doc technician -- */

const extraction = (field_key, value, corrected_value) => ({ field_key, value, corrected_value });

eq('docTechnicianName reads the technician field', docTechnicianName([extraction('technician', 'D. Ramirez')]), 'D. Ramirez');
eq('a correction wins over the raw value', docTechnicianName([extraction('technician', 'D. Ramirez', 'Dana Ramirez')]), 'Dana Ramirez');
eq('no technician field -> null', docTechnicianName([extraction('customer_name', 'Plaza Dental')]), null);
eq('an empty/blank value -> null', docTechnicianName([extraction('technician', '   ')]), null);
eq('an empty extraction list -> null', docTechnicianName([]), null);

/* ---------------------------------------------------------- missing fields */

eq(
  'missingFieldsForDocument reuses documentTypes.js completenessFor: work-order missing everything',
  missingFieldsForDocument({ document_type: 'work-order', extractions: [] }),
  ['service_address', 'service_date', 'technician']
);
eq(
  'missingFieldsForDocument: a satisfied requirement drops out',
  missingFieldsForDocument({
    document_type: 'work-order',
    extractions: [
      { field_key: 'service_address', value: '123 Main St', confidence: 0.9 },
      { field_key: 'service_date', value: '2026-09-01', confidence: 0.9 },
    ],
  }),
  ['technician']
);
eq('missingFieldsForDocument: a fully satisfied document has nothing missing', missingFieldsForDocument({
  document_type: 'nameplate-photo',
  extractions: [
    { field_key: 'serial_number', value: 'ABC123', confidence: 0.9 },
    { field_key: 'model', value: 'GSX140361K', confidence: 0.9 },
  ],
}), []);
eq('missingFieldsForDocument: an unclassified document has nothing required', missingFieldsForDocument({ document_type: null, extractions: [] }), []);

eq('missingFieldsPlainWords: single field', missingFieldsPlainWords(['serial_number']), 'serial number');
eq('missingFieldsPlainWords: an "a|b" requirement joins with "or"', missingFieldsPlainWords(['warranty_expires|warranty_term']), 'warranty expires or term');
eq('missingFieldsPlainWords: several requirements join with commas', missingFieldsPlainWords(['service_address', 'service_date', 'technician']), 'service address, service date, technician');
eq('missingFieldsPlainWords: empty list -> empty string', missingFieldsPlainWords([]), '');

/* ---------------------------------------------------------------- grouping */

const admin = { userId: 'u-admin', displayName: 'Sterling Chapman', email: 'sterling@example.com', isAdmin: true };
const dana = { userId: 'u-dana', displayName: 'Dana Ramirez', email: 'dana@example.com', isAdmin: false };
const chris = { userId: 'u-chris', displayName: 'Chris Nguyen', email: 'chris@example.com', isAdmin: false };
const members = [admin, dana, chris];

const doc = (overrides) => ({ id: 'doc-1', filename: 'file.pdf', uploadedBy: null, technicianName: null, missing: ['serial_number'], ...overrides });

eq('memberForDocument: uploader id wins first', memberForDocument(doc({ uploadedBy: 'u-dana', technicianName: 'Chris Nguyen' }), members), dana);
eq('memberForDocument: falls to technician-name match when no uploader match', memberForDocument(doc({ uploadedBy: 'u-unknown', technicianName: 'D. Ramirez' }), members), dana);
eq('memberForDocument: falls to technician-name match when uploadedBy is null', memberForDocument(doc({ technicianName: 'Chris Nguyen' }), members), chris);
eq('memberForDocument: unassigned falls to the admin', memberForDocument(doc({}), members), admin);
eq('memberForDocument: no admin on the roster -> null', memberForDocument(doc({}), [dana, chris]), null);

{
  const docs = [
    doc({ id: 'd1', filename: 'a.pdf', uploadedBy: 'u-dana', missing: ['serial_number'] }),
    doc({ id: 'd2', filename: 'b.pdf', technicianName: 'D. Ramirez', missing: ['model'] }),
    doc({ id: 'd3', filename: 'c.pdf', missing: ['technician'] }), // unassigned -> admin
    doc({ id: 'd4', filename: 'd.pdf', missing: [] }), // nothing missing -> excluded entirely
  ];
  const groups = groupDocsByTechnician(docs, members);
  eq('groupDocsByTechnician: three groups (dana, admin) — chris gets none', [...groups.keys()].sort(), ['u-admin', 'u-dana'].sort());
  eq('groupDocsByTechnician: dana gets both her uploaded and technician-matched docs', groups.get('u-dana').docs.map((d) => d.id), ['d1', 'd2']);
  eq('groupDocsByTechnician: unassigned doc routes to the admin', groups.get('u-admin').docs.map((d) => d.id), ['d3']);
  check('groupDocsByTechnician: a doc with nothing missing never appears in any group', ![...groups.values()].some((g) => g.docs.some((d) => d.id === 'd4')));
}

{
  const groups = new Map();
  for (let i = 0; i < 5; i++) groups.set(`u-${i}`, { member: { userId: `u-${i}`, displayName: `Tech ${i}`, isAdmin: false }, docs: new Array(5 - i).fill(0).map((_, j) => doc({ id: `d${i}-${j}` })) });
  const selected = selectGroupsForRun(groups, 3);
  eq('selectGroupsForRun: caps to `max`, biggest backlog first', selected.map((g) => g.member.userId), ['u-0', 'u-1', 'u-2']);
  eq('selectGroupsForRun: default cap is FOLLOWUP_MAX_MESSAGES_PER_RUN', selectGroupsForRun(groups).length, Math.min(groups.size, FOLLOWUP_MAX_MESSAGES_PER_RUN));
}

/* --------------------------------------------------------- message render */

{
  const shortGroup = { docs: [doc({ filename: '48-invoice-whitmore.pdf', missing: ['installation_date', 'serial_number'] })] };
  const msg = renderFollowupMessage(shortGroup, 'https://deepwelltechnology.com');
  eq('renderFollowupMessage: singular subject for one document', msg.subject, '1 document needs a detail from you');
  check('renderFollowupMessage: lists the filename and its missing fields in plain words', msg.text.includes('48-invoice-whitmore.pdf — installation date, serial number'));
  eq('renderFollowupMessage: link is the app URL + FOLLOWUP_INBOX_LINK', msg.link, `https://deepwelltechnology.com${FOLLOWUP_INBOX_LINK}`);
  check('renderFollowupMessage: text includes the Inbox link', msg.text.includes(msg.link));
  check('renderFollowupMessage: html includes an anchor to the link', msg.html.includes(`href="${msg.link}"`));
  eq('renderFollowupMessage: itemCount/shownCount for a small group', [msg.itemCount, msg.shownCount], [1, 1]);
}

{
  const bigDocs = new Array(25).fill(0).map((_, i) => doc({ id: `d${i}`, filename: `file-${i}.pdf` }));
  const msg = renderFollowupMessage({ docs: bigDocs }, 'https://deepwelltechnology.com');
  eq('renderFollowupMessage: plural subject for many documents', msg.subject, '25 documents need a detail from you');
  eq('renderFollowupMessage: caps the listed documents at FOLLOWUP_MAX_DOCS_PER_MESSAGE', msg.shownCount, FOLLOWUP_MAX_DOCS_PER_MESSAGE);
  check('renderFollowupMessage: an overflow tail names how many more', msg.text.includes(`…and ${25 - FOLLOWUP_MAX_DOCS_PER_MESSAGE} more`));
  check('renderFollowupMessage: html also carries the overflow tail', msg.html.includes('…and 5 more'));
}

check('FOLLOWUP_MAX_DOCS_PER_MESSAGE is 20 per the brief', FOLLOWUP_MAX_DOCS_PER_MESSAGE === 20);

/* -------------------------------------------------------------- debounce */

const oneDayMs = FOLLOWUP_DEBOUNCE_HOURS * 60 * 60 * 1000;
const now = Date.parse('2026-09-21T12:00:00Z');

check('canSendFollowup: nothing on file yet -> allowed', canSendFollowup({}, 'u-dana', now));
check('canSendFollowup: sent just now -> blocked', !canSendFollowup({ 'u-dana': new Date(now).toISOString() }, 'u-dana', now));
check('canSendFollowup: sent 23h59m ago -> still blocked', !canSendFollowup({ 'u-dana': new Date(now - oneDayMs + 60_000).toISOString() }, 'u-dana', now));
check('canSendFollowup: sent exactly 24h ago -> allowed again', canSendFollowup({ 'u-dana': new Date(now - oneDayMs).toISOString() }, 'u-dana', now));
check('canSendFollowup: an unparseable timestamp fails open (allowed)', canSendFollowup({ 'u-dana': 'not-a-date' }, 'u-dana', now));
check('canSendFollowup: a different technician is unaffected by dana\'s debounce', canSendFollowup({ 'u-dana': new Date(now).toISOString() }, 'u-chris', now));

{
  const merged = recordFollowupSent({ 'u-dana': '2026-09-01T00:00:00.000Z' }, 'u-chris', '2026-09-21T12:00:00.000Z');
  eq('recordFollowupSent: merges a new key in alongside existing ones', Object.keys(merged).sort(), ['u-chris', 'u-dana']);
  eq('recordFollowupSent: the new timestamp is recorded exactly', merged['u-chris'], '2026-09-21T12:00:00.000Z');
}

{
  let map = {};
  for (let i = 0; i < FOLLOWUP_LAST_SENT_CAP + 10; i++) {
    map = recordFollowupSent(map, `u-${i}`, new Date(now - i * 1000).toISOString()); // earlier i = more recent
  }
  eq('recordFollowupSent: caps entry count at FOLLOWUP_LAST_SENT_CAP', Object.keys(map).length, FOLLOWUP_LAST_SENT_CAP);
  check('recordFollowupSent: keeps the most-recently-sent entries, drops the oldest', 'u-0' in map && 'u-199' in map && !('u-209' in map));
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
