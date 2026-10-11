/**
 * dql/registry.js - the small interface the DQL core keeps open for families.
 *
 * A family is a plain object in dql/families/<name>.js:
 *   {
 *     id:     'core',
 *     ops:    ['count', 'sum', ...],                 // plan.op values this family executes and words
 *     detect(feat, h) -> plan | null,                // reads the parsed features (see parse.js); null = not mine
 *     exec(plan, x)  -> result | {abstain: why},     // x = {snap, today, h}; h = the shared helpers in exec.js
 *     say(result, plan, x) -> {text, facts, records, basis}
 *   }
 * The registry runs every family's detect() in registration order. Exactly one plan may come back: two families claiming the same
 * question is treated as "not understood" (the question is released), never as a coin toss.
 * To add a family: create the file and add one import line to families/index.js. Nothing else in the core changes.
 */
const FAMILIES = [];

export function registerFamily(fam) {
  if (!fam || !fam.id || !Array.isArray(fam.ops)) throw new Error('dql: a family needs an id and an ops list');
  if (FAMILIES.some((f) => f.id === fam.id)) return fam;
  FAMILIES.push(fam);
  return fam;
}
/** Diagnostic switch: DONOVAN_DQL_FAMILY_OFF=sets,textdq leaves those families out of every look (slots, detect, rescue). */
const famOn = (f) => { const off = process.env.DONOVAN_DQL_FAMILY_OFF; return !off || !off.split(',').some((x) => x.trim() === f.id); };
/** Diagnostic switch: DONOVAN_DQL_OPS_OFF=set_rank,duplicates drops the plans of those ops (the question is then released). */
const opOff = (p) => { const off = process.env.DONOVAN_DQL_OPS_OFF; return Boolean(off) && off.split(',').some((x) => { const k = x.trim(); return k === p.op || (p.dim && k === `${p.op}:${p.dim}`) || (p.by && k === `${p.op}:${p.by}`); }); };
export const allFamilies = () => FAMILIES.filter(famOn);
export const familyForOp = (op) => FAMILIES.find((f) => f.ops.includes(op)) ?? null;

/** Run every family's detector; the single claimed plan, or null (none claimed, or more than one did). */
export function detectPlan(feat, h) {
  const claims = [];
  for (const fam of allFamilies()) {
    let p = null;
    try { p = fam.detect ? fam.detect(feat, h) : null; } catch (e) { if (process.env.DQL_DEBUG) console.error("dql detect error", e); p = null; }
    if (p && !opOff(p)) claims.push(p);
  }
  if (claims.length > 1) {
    // a family may declare that its plan outranks another's for a question both read the same way (family.beats(mine, other)): exactly one such winner keeps it
    const winners = claims.filter((p) => { const fam = familyForOp(p.op); return fam?.beats && claims.every((o) => o === p || fam.beats(p, o)); });
    if (winners.length === 1) return winners[0];
  }
  return claims.length === 1 ? claims[0] : null;
}

/** Questions with words the core slots did not explain: every family that can read those words itself (family.rescue) gets one look; the single claimed plan, or null. */
export function rescuePlan(feat, h) {
  const claims = [];
  for (const fam of allFamilies()) {
    if (!fam.rescue) continue;
    let p = null;
    try { p = fam.rescue(feat, h); } catch (e) { if (process.env.DQL_DEBUG) console.error("dql rescue error", e); p = null; }
    if (p && !opOff(p)) claims.push(p);
  }
  return claims.length === 1 ? claims[0] : null;
}
