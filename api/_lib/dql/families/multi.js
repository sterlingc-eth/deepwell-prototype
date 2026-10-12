/**
 * dql/families/multi.js - executes and words a two-measure plan built by dql/multi.js: each part runs through its own family, and the answer
 * is the parts' sentences in the order asked. If any part abstains, the whole question abstains (never half an answer).
 */
import { registerFamily, familyForOp } from '../registry.js';
import { execute } from '../exec.js';

function exec(plan, x) {
  const out = [];
  for (const p of plan.parts ?? []) {
    const r = execute(p, x.snap, { today: x.today });
    if (!r || r.abstain) return { abstain: r?.abstain ?? 'part' };
    out.push(r);
  }
  return { op: 'multi', results: out, n: out[0]?.n ?? 0 };
}

function say(res, plan, x) {
  const said = [];
  for (let i = 0; i < plan.parts.length; i++) {
    const fam = familyForOp(plan.parts[i].op);
    const s = fam?.say(res.results[i], plan.parts[i], x);
    if (!s || !s.text) return null;
    said.push(s);
  }
  const seen = new Set(); const records = [];
  for (const s of said) for (const r of s.records ?? []) { const k = `${r.type}:${r.id}`; if (!seen.has(k)) { seen.add(k); records.push(r); } }
  const text = said.map((s) => String(s.text).trim()).join(' ');
  return { text, facts: said.flatMap((s) => s.facts ?? []), records, total: records.length || undefined, claimedCount: null, basis: said.map((s) => s.basis).filter(Boolean).join(' ') || undefined };
}

registerFamily({ id: 'multi', ops: ['multi'], exec, say });
