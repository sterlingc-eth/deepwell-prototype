/**
 * dql/index.js - the Donovan Query Language entry points.
 *
 *   parseDql(question, ctx)          pure: question -> {mode:'dql', plan, text} | null   (null = release, never a guess)
 *   runDql(db, intent, {today})      one tenant-scoped snapshot, the plan executed over it, the answer written with its basis and records
 *
 * Wired in router/classifyAll.js (after the wording model, only when no lane claimed the question, or when the only claim is the
 * model-planned analytics lane) and in decompose/index.js (runDecompose delegates mode 'dql' here). Kill switch: DONOVAN_DQL=0.
 */
import { answerEnvelope, todayIso } from '../scope.js';
import { attachCitations } from '../citations/records.js';
import { parseDql, dqlEnabled } from './parse.js';
import { loadSnapshot } from './load.js';
import { execute } from './exec.js';
import { familyForOp } from './registry.js';
import { resolveProvenance } from '../citations/provenance.js';
import { sourcesSentence } from './cite.js';
import { loadReaderPages } from './families/reader.js';
import { loadFindPages } from './families/pagefind.js';

export { parseDql, dqlEnabled };

export async function runDql(db, intent, { today } = {}) {
  if (!intent?.plan || !dqlEnabled()) return null;
  const t = todayIso(today);
  let snap = await loadSnapshot(db, { today: t });
  if (snap.truncated) return null; // more records than one read holds: no answer is better than a partial one
  // the snapshot is shared between requests, so the reader's pages go on a shallow copy
  if (intent.plan.op === 'read_span') { snap = { ...snap }; try { await loadReaderPages(db, snap, intent.plan, t); } catch { return null; } } // the extractive reader reads the pages of the few candidate papers only
  if (intent.plan.op === 'page_find') { snap = { ...snap }; try { await loadFindPages(db, snap, intent.plan); } catch { return null; } } // the page search reads the pages that could hold the phrase (private papers never)
  let ans = await resolveProvenance(db, answerFromSnapshot(snap, intent.plan, t));
  // R22: the page search took a plain "which papers mention X" from the older text search / document finder; when it cannot answer (papers without readable text, an unknown word), the older plan answers exactly as it did before
  if (!ans && intent.plan.op === 'page_find' && intent.plan.older) { const o = intent.plan.older; intent = { ...intent, plan: o }; snap = { ...snap }; ans = await resolveProvenance(db, answerFromSnapshot(snap, o, t)); }
  // the "Sources:" sentence was written before the pages were looked up: write it again with them
  if (ans && intent.plan.cite && ans.records?.length && /\sSources: /.test(ans.text)) {
    const src = sourcesSentence(ans.records, ans.recordsTotal);
    if (src) ans.text = ans.text.replace(/\s+Sources: .*$/s, ` ${src}`);
  }
  return ans;
}

/** Pure half of runDql (the verify script and the dev harness run it over a snapshot built from an export file). */
export function answerFromSnapshot(snap, plan, today) {
  const fam = familyForOp(plan.op);
  if (!fam) return null;
  const res = execute(plan, snap, { today });
  // a full name on file twice (two customers called Judy Cruz): ask which one, with where each lives, instead of answering for one of them
  if (res?.abstain === 'ambiguous-name' && res.name) {
    const same = snap.customers.filter((c) => String(c.name).toLowerCase() === String(res.name).toLowerCase());
    if (same.length > 1) {
      // say where each lives; when two share a city, the street address tells them apart, and when that is the same too, the customer number
      const pick = (c, f) => (f === 'city' ? c.city : f === 'address' ? c.address : c.number != null ? `no. ${c.number}` : null);
      const field = ['city', 'address', 'number'].find((f) => new Set(same.map((c) => pick(c, f) ?? '')).size === same.length && same.every((c) => pick(c, f))) ?? null;
      const where = same.map((c) => `${c.name} (${(field ? pick(c, field) : (c.city ?? c.address ?? pick(c, 'number'))) ?? 'no address'})`);
      const text = `${res.name} is on file ${same.length === 2 ? 'twice' : `${same.length} times`}: ${where.join(' and ')}. Which one do you mean?`;
      return attachCitations(answerEnvelope({ text, facts: [] }), { records: same.map((c) => ({ type: 'customer', id: c.id, label: c.name, sublabel: c.address ?? undefined })), total: same.length, basis: `Looked for ${res.name} among the customers on file.`, kind: 'basis' });
    }
  }
  if (!res || res.abstain) return null;
  const said = fam.say(res, plan, { snap, today });
  if (!said || !said.text) return null;
  // A long list is cut in the sentence ("... and 30 more"); the older lanes also listed every item as a fact, so the whole list stays readable and checkable.
  let facts = said.facts ?? [];
  if (/\band \d[\d,]* more\b/.test(said.text) && facts.length <= 1 && (said.records?.length ?? 0) > 1) {
    facts = said.records.slice(0, 200).map((r) => ({ label: String(r.label ?? ''), value: String(r.sublabel ?? '') })).filter((f) => f.label);
  }
  let sayText = said.text;
  if (plan.staffWord && /^[a-z]+$/.test(plan.staffWord)) { const sw = plan.staffWord; sayText = sayText.replace(/\btechnicians\b/g, `${sw}s`).replace(/\btechnician\b/g, sw); }
  if (plan.cite && said.records?.length) { const src = sourcesSentence(said.records, said.total); if (src) sayText = `${sayText} ${src}`; }
  const data = answerEnvelope({ text: sayText, facts });
  return attachCitations(data, { records: said.records ?? [], total: said.total, claimedCount: said.claimedCount ?? null, basis: said.basis, kind: (said.records?.length ? 'basis' : 'searched') });
}
