/**
 * The starter-question grader, shared by the local QA run (qa-run.mjs) and the staging QA run (qa-staging.mjs).
 * It reads only the question, its expected values and its expected source document/page. It never feeds anything back
 * into Donovan.
 *
 * PASS = every expected value is in the answer (any listed spelling) AND one cited source is the expected document on the
 * expected page AND Donovan did not decline; for the not-in-records question PASS = Donovan declines honestly.
 */
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

export function answerText(d) {
  if (!d) return '';
  const parts = [d.text, d.answer, ...(d.facts ?? []).flatMap((f) => [f.label, f.value]), ...(d.rows ?? []).flatMap((r) => Object.values(r ?? {}))];
  return norm(parts.filter((x) => x != null).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' \n '));
}

export function citedSources(d) {
  const out = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x.documentId === 'string') out.push({ documentId: x.documentId, page: Number(x.location?.page ?? x.page ?? x.pageNo ?? x.page_no ?? 1) || 1 });
    for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v);
  };
  walk(d?.facts); walk(d?.sources); walk(d?.citations); walk(d?.rows);
  return out;
}

export const DECLINE_RE = /\b(?:no [\w ]{1,40} (?:on file|in (?:your|the) records)|nothing on file|couldn'?t find|could not find|can'?t find|cannot find|no record|not in (?:your|the) (?:records|documents)|don'?t (?:see|have)|nothing (?:in|on) (?:your|the)|isn'?t in|wasn'?t (?:found|in)|no (?:matching|documents?)|not (?:found|listed|recorded|on file)|i don'?t know)\b/i;

/**
 * @param {object} q        starter question {q, expect[], file, page, notInRecords}
 * @param {object|null} data  the /api/ask response `data`
 * @param {(file:string)=>string|undefined} idOf  file name -> document id in this company
 * @param {(id:string)=>string} nameOf  document id -> file name (for the report)
 */
export function grade(q, data, idOf, nameOf = (x) => x) {
  const text = answerText(data);
  const declined = data?.kind === 'no-answer' || DECLINE_RE.test(String(data?.text ?? ''));
  const why = [];
  if (q.notInRecords) {
    if (!declined) why.push('did not decline');
    return { pass: declined, why: why.join('; ') };
  }
  const missing = (q.expect ?? []).filter((alts) => !alts.split('|').some((a) => text.includes(norm(a))));
  if (missing.length) why.push(`missing ${missing.join(' & ')}`);
  const want = q.file.split('|').map(idOf).filter(Boolean);
  const cites = citedSources(data);
  const citeOk = cites.some((c) => want.includes(c.documentId) && (c.page === q.page || q.page == null));
  if (!citeOk) why.push(cites.length ? `cited ${cites.slice(0, 3).map((c) => `${nameOf(c.documentId)}#p${c.page}`).join(', ')}` : 'no citation');
  if (declined) why.push('declined');
  return { pass: !missing.length && citeOk && !declined, why: why.join('; ') };
}
