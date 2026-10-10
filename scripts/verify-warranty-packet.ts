/**
 * Checks for the warranty claim packet builder (src/core/warrantyPacket.ts) against realistic sample shop data
 * shaped like the live graph. Pure: no DOM, no network.
 *
 *   TZ=America/Phoenix npx tsx scripts/verify-warranty-packet.ts
 */
import { buildPacket } from '../src/core/warrantyPacket';
import { sampleGraph, NOW } from './lib/warranty-packet-fixture';
import { whyLine } from '../src/screens/OutreachScreen';

let failures = 0;
let passes = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const g = sampleGraph();
const p1 = buildPacket(g, g.entities['unit-1'], NOW);

/* ---- customer: read from the customer record, not from a property that live data does not have ---- */
eq('customer name and number', [p1.customer.name, p1.customer.number], ['Carol Rios', 'C-00001']);
eq('customer service address', p1.customer.address, '412 Elm St, Mesa, AZ 85201');
eq('customer phone and email', [p1.customer.phone, p1.customer.email], ['(480) 555-0148', 'carol.rios@example.com']);

/* ---- unit ---- */
eq('unit identity', [p1.unit.serial, p1.unit.model, p1.unit.manufacturer, p1.unit.equipmentType], ['TR2306A1234', 'XR16', 'Trane', 'Condensing unit']);
eq('install date is the stored calendar day (no timezone slip)', p1.unit.installDate, 'Jun 12, 2023');
eq('installer', p1.unit.installedBy, 'D. Ramirez');

/* ---- warranty terms ---- */
eq('expiry is the stored calendar day', p1.warranty.expires, 'Jun 12, 2033');
eq('status is in warranty', p1.warranty.status, 'active');
eq('manufacturer term as printed', p1.warranty.termPrinted, '10 year parts limited');
eq('term works out to ten years from install', p1.warranty.termYears, 10);
eq('registered date', p1.warranty.registeredOn, 'Jul 1, 2023');
eq('expiry date was printed on the registration', p1.warranty.expiryBasis, 'printed');

/* ---- supporting documents ---- */
const byHeading = Object.fromEntries(p1.documents.map((x) => [x.heading, x.docs.map((y) => y.id)]));
eq('documents are grouped by what they prove', byHeading, {
  'Warranty registration': ['d-reg'],
  'Installation and equipment records': ['d-startup'],
  'Proof of purchase': ['d-inv'],
  'Maintenance agreements': ['d-maint'],
  'Service records': ['d-svc1', 'd-svc2'],
});
const allIds = p1.documents.flatMap((x) => x.docs.map((y) => y.id));
check('an insurance certificate is never listed as claim evidence', !allIds.includes('d-coi'));
check('an unverified registration is not listed', !allIds.includes('d-unver'));
check("another unit's service ticket is not listed", !allIds.includes('d-svc-other'));
eq('document count', p1.documentCount, 6);
check('friendly name is used, original filename kept alongside', p1.documents[0].docs[0].name.startsWith('Warranty · Carol Rios') && p1.documents[0].docs[0].filename === 'trane-registration-carol.pdf');

/* ---- service history ---- */
eq('service history, newest first, from the service documents', p1.serviceHistory.map((v) => [v.date, v.work, v.technician]), [
  ['Mar 19, 2026', 'Spring tune-up and coil cleaning', 'S. Patel'],
  ['Apr 8, 2025', 'Replaced run capacitor; Cleared condensate drain', 'D. Ramirez'],
]);

/* ---- readiness ---- */
eq('unit 1 is ready', [p1.ready, p1.missing, p1.advisories], [true, [], []]);

const p2 = buildPacket(g, g.entities['unit-2'], NOW);
eq('unit 2: customer comes from the customer record when the unit has no name', p2.customer.name, 'Plaza Dental Group');
check('unit 2: an insurance certificate alone does not make a unit claim-ready, but its invoice does', p2.ready && p2.documentCount === 1);
eq('unit 2: missing installer is advice, not a blocker', p2.advisories, ['Installer not on file']);
eq('unit 2: nothing printed, so the expiry is calculated', p2.warranty.expiryBasis, 'computed');
eq('unit 2: no service visits is stated plainly', p2.serviceHistory, []);

const p3 = buildPacket(g, g.entities['unit-3'], NOW);
eq('unit 3: expired warranty blocks the claim', [p3.ready, p3.warranty.status, p3.warranty.statusLabel], [false, 'expired', 'Expired 101 days ago']);

const p4 = buildPacket(g, g.entities['unit-4'], NOW);
eq('unit 4: names what is missing', p4.missing, ['serial', 'install date', 'warranty registration']);
eq('unit 4: falls back to the name and address on the unit itself', [p4.customer.name, p4.customer.address], ['Mesa Pines HOA', '9 Pine Ct, Mesa, AZ 85205']);
check('unit 4 is not ready', !p4.ready);

/* ---- a certificate-only unit is not ready ---- */
{
  const g2 = sampleGraph();
  delete g2.docs['d-lennox-inv'];
  const p = buildPacket(g2, g2.entities['unit-2'], NOW);
  eq('only an insurance certificate linked: no claim documents, not ready', [p.documentCount, p.ready], [0, false]);
}

/* ---- the outreach "why" line uses the same calendar-day rule ---- */
eq('whyLine: days left', whyLine('2026-11-19', new Date(2026, 9, 10)), 'Warranty ends Nov 19, 2026 · 40 days left');
eq('whyLine: already ended', whyLine('2026-07-02', new Date(2026, 9, 10)), 'Warranty ended Jul 2, 2026');
eq('whyLine: nothing on file', whyLine(null), null);

{
  const fs = await import('node:fs');
  const w = fs.readFileSync(new URL('../src/screens/WarrantyExportScreen.tsx', import.meta.url), 'utf8');
  check('screen: the packet preview fits a 390px phone (no fixed 640px sheet)', !w.includes('min-w-[640px]') && w.includes('p-4 sm:p-8'));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`All warranty packet checks passed (${passes}).`);
