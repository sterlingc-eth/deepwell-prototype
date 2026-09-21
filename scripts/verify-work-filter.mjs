/**
 * Unit checks for the "My work / Everyone" per-technician filter
 * (src/core/workFilter.ts) — owner brief 2026-09-21,
 * TECH_FILTER_AND_OUTREACH_COPY. Pure functions only, no DOM, no Clerk, no
 * store, no database.
 *
 * Run via tsx (imports a .ts source file directly, same technique
 * scripts/verify-linking.mjs and scripts/verify-ui.ts already use).
 *
 *   npx tsx scripts/verify-work-filter.mjs
 */
import {
  docTechnicianName,
  technicianNameMatches,
  isMineDoc,
  filterDocsForWork,
  defaultWorkFilterChoice,
} from '../src/core/workFilter';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** Minimal doc fixture — only the two fields workFilter.ts reads. */
function doc({ uploadedBy = undefined, technician = undefined, correctedTechnician = undefined } = {}) {
  const extracted = [];
  if (technician !== undefined || correctedTechnician !== undefined) {
    extracted.push({
      name: 'technician',
      value: technician ?? '',
      confidence: 0.9,
      location: {},
      ...(correctedTechnician !== undefined ? { correctedValue: correctedTechnician } : {}),
    });
  }
  return { extracted, uploadedBy };
}

/* --------------------------------------------------------- docTechnicianName */

eq('docTechnicianName: reads the technician field value', docTechnicianName(doc({ technician: 'Dana Ramirez' })), 'Dana Ramirez');
eq('docTechnicianName: a correction wins over the raw value', docTechnicianName(doc({ technician: 'D. Ramirez', correctedTechnician: 'Dana Ramirez' })), 'Dana Ramirez');
eq('docTechnicianName: no technician field on file is null', docTechnicianName(doc({})), null);
eq('docTechnicianName: blank value is null, not empty string', docTechnicianName(doc({ technician: '   ' })), null);

/* ----------------------------------------------------- technicianNameMatches */

check('technicianNameMatches: exact match, case-insensitive', technicianNameMatches('dana ramirez', 'Dana Ramirez'));
check('technicianNameMatches: first+last inside a longer technician string', technicianNameMatches('Dana Ramirez - Lead Tech', 'Dana Ramirez'));
check('technicianNameMatches: last name alone (initialed first name)', technicianNameMatches('D. Ramirez', 'Dana Ramirez'));
check('technicianNameMatches: last name alone, plain', technicianNameMatches('Ramirez', 'Dana Ramirez'));
check('technicianNameMatches: no match for an unrelated name', !technicianNameMatches('Chris Lee', 'Dana Ramirez'));
check('technicianNameMatches: first-name-only substring does NOT match (avoid roster false positives)', !technicianNameMatches('Dana', 'Dana Ramirez'));
check('technicianNameMatches: blank technician never matches', !technicianNameMatches('', 'Dana Ramirez'));
check('technicianNameMatches: blank display name never matches', !technicianNameMatches('Dana Ramirez', ''));
check('technicianNameMatches: null/undefined inputs never match', !technicianNameMatches(null, undefined));

/* ------------------------------------------------------------------ isMineDoc */

{
  const me = { userId: 'user_1', displayName: 'Dana Ramirez' };
  check('isMineDoc: mine by uploader id', isMineDoc(doc({ uploadedBy: 'user_1' }), me));
  check('isMineDoc: mine by technician name match (last name)', isMineDoc(doc({ uploadedBy: 'user_2', technician: 'D. Ramirez' }), me));
  check('isMineDoc: NOT mine — uploaded by someone else, no technician match', !isMineDoc(doc({ uploadedBy: 'user_2', technician: 'Chris Lee' }), me));
  check('isMineDoc: NOT mine — no uploader, no technician at all', !isMineDoc(doc({}), me));
  check('isMineDoc: a document with no displayName known for me never matches on technician', !isMineDoc(doc({ technician: 'Dana Ramirez' }), { userId: 'user_1', displayName: null }));
}

/* ------------------------------------------------------------- filterDocsForWork */

{
  const me = { userId: 'user_1', displayName: 'Dana Ramirez' };
  const docs = [
    doc({ uploadedBy: 'user_1' }),        // mine, by upload
    doc({ uploadedBy: 'user_2', technician: 'Dana Ramirez' }), // mine, by technician
    doc({ uploadedBy: 'user_2', technician: 'Chris Lee' }),    // not mine
    doc({ uploadedBy: 'user_3' }),        // not mine
  ];
  eq('filterDocsForWork: "everyone" returns every doc, unfiltered', filterDocsForWork(docs, 'everyone', me).length, docs.length);
  eq('filterDocsForWork: "mine" keeps only the attributed two', filterDocsForWork(docs, 'mine', me).length, 2);
}

/* ---------------------------------------------------------- defaultWorkFilterChoice */

eq('defaultWorkFilterChoice: no shop (solo) is always Everyone, regardless of count', defaultWorkFilterChoice({ hasShop: false, isAdmin: false, attributedDocCount: 5 }), 'everyone');
eq('defaultWorkFilterChoice: admin is always Everyone, regardless of count', defaultWorkFilterChoice({ hasShop: true, isAdmin: true, attributedDocCount: 5 }), 'everyone');
eq('defaultWorkFilterChoice: non-admin member with >=1 attributed doc defaults to Mine', defaultWorkFilterChoice({ hasShop: true, isAdmin: false, attributedDocCount: 1 }), 'mine');
eq('defaultWorkFilterChoice: non-admin member with zero attributed docs (fresh account) defaults to Everyone', defaultWorkFilterChoice({ hasShop: true, isAdmin: false, attributedDocCount: 0 }), 'everyone');

console.log(failures === 0 ? `\nAll work-filter checks passed.` : `\n${failures} work-filter check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
