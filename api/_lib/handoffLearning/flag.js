/**
 * handoffLearning/flag.js - the one switch for "learn from every handoff" (round 24). OFF by default.
 * DONOVAN_HANDOFF_LEARNING=1 turns on (a) recording grounded handoffs, (b) reading the adopted learnings of the organization while questions are read.
 * With the switch off nothing here touches the database and the parser sees no overlay: Donovan behaves exactly as before.
 */
export const handoffLearningEnabled = (env = process.env) => /^(?:1|true|on|yes)$/i.test(String(env?.DONOVAN_HANDOFF_LEARNING ?? '').trim());

/** Knobs of the adoption rules (all conservative; the job may be given stricter ones, never looser than the floors). */
export const LIMITS = Object.freeze({
  minSupportWord: 2,      // a word / wording mapping must be confirmed by this many different handoffs
  minSupportFiller: 3,    // a filler word, by this many
  minParaphrases: 4,      // usable paraphrase pairs that must agree, none may disagree
  maxPhraseWords: 3,      // longest wording a learning may cover
  maxActivePerTenant: 400,
  ttlDays: 90,            // an adopted learning expires after this many days unless the job re-confirms it
  handoffTtlDays: 14,     // raw question text of a recorded handoff is blanked after the job read it, and removed after this long at the latest
  sharedMinCompanies: 3,  // a learning is shared across organizations only when this many independently confirmed it with no conflict
});
