/**
 * handoffLearning/shared.js - a learning leaves one organization only when it is generic (a filler word, or a wording of an entity / operator / dimension: never a kind of paper, a name or
 * a number) AND at least three organizations confirmed it on their own (adopted, still active, never retired) AND no organization holds a conflicting or retired learning for the same words.
 * Pure: takes the per-organization rows, returns what to share. No question text, no company data is in the result.
 */
import { LIMITS } from './flag.js';

export function promoteShared(perCompany, { limits = LIMITS, alreadyShared = [] } = {}) {
  const seen = new Map(); // key -> {kind, phrase, canonical, companies:Set, conflict}
  const bad = new Set();
  for (const [company, rows] of perCompany) {
    for (const r of rows) {
      const key = `${r.kind === 'filler' ? 'filler' : 'rewrite'}|${r.phrase}`;
      if (r.status === 'retired') { bad.add(key); continue; }
      if (r.status && r.status !== 'active') continue;
      const generic = r.kind === 'filler' || ['entity', 'operator', 'dimension'].includes(r.targetKind ?? r.target_kind);
      if (!generic) continue;
      const e = seen.get(key) ?? { kind: r.kind === 'filler' ? 'filler' : r.kind, phrase: r.phrase, canonical: r.canonical ?? '', companies: new Set(), conflict: false };
      if ((e.canonical ?? '') !== (r.canonical ?? '')) e.conflict = true;
      e.companies.add(company); seen.set(key, e);
    }
  }
  // another organization holding the same words as something else (its own wording for a different thing) is a conflict even if it never adopted this one
  const out = [];
  for (const [key, e] of seen) {
    if (e.conflict || bad.has(key) || e.companies.size < limits.sharedMinCompanies) continue;
    out.push({ kind: e.kind, phrase: e.phrase, canonical: e.canonical, nCompanies: e.companies.size });
  }
  const retire = alreadyShared.filter((s) => bad.has(`${s.kind === 'filler' ? 'filler' : 'rewrite'}|${s.phrase}`) || seen.get(`${s.kind === 'filler' ? 'filler' : 'rewrite'}|${s.phrase}`)?.conflict);
  return { share: out, retire };
}
