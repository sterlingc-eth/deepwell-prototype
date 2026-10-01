/**
 * R32 (CEO decision 2026-09-30) — TYPO'D CUSTOMER NAMES AUTO-RESOLVE, VISIBLY, WHEN UNAMBIGUOUS.
 *
 * Before: any multi-word customer name that matched only through the edit-distance scan ("sanrda wyckoff") got a
 * name-only "Did you mean Sandra Wyckoff?" and the tech had to tap. Now, when the near-miss is unambiguous, the answer is
 * given straight away, prefixed with a visible note ("Showing results for Sandra Wyckoff (you typed "sanrda wyckoff").")
 * and the client offers a one-tap "Not who you meant?" (src/core/suggestions.ts typoNoteChip). Everything that does not
 * clear the bar below keeps the existing "Did you mean" chips, unchanged.
 *
 * POLICY (all must hold, else no auto-resolve):
 *   1. a FULL name (2-3 words) that matched no customer exactly, and exactly ONE customer row in the fuzzy result;
 *   2. same number of words as that customer's name; per word Damerau-Levenshtein <= 2 (<= 1 when either word is under 6
 *      letters; a mistyped word must be at least 4 letters on both sides ("Bo Rey" is not a typo of "Bo Ray"); shorter words must match exactly); total edits across words <= 2; the FULL names within 2;
 *   3. no OTHER customer name within full-name distance <= 3 of what was typed;
 *   4. a mistyped word is not itself a real word / common given name / common surname / brand / city / street word
 *      ("Rob Smith" is not a typo of "Bob Smith"), and is not an exact word of any customer's name on file ("typo that
 *      happens to be a different customer's surname");
 *   5. the question does not carry the name in quotes (the "Not who you meant?" chip re-asks with the typed name quoted,
 *      meaning "as typed", which restores the honest decline);
 *   6. a request scope is open (withTypoNote) so the note can be attached to the answer. No scope, no auto-resolve
 *      (verify scripts that call the resolvers directly keep the old behaviour).
 * Kill switch: DONOVAN_TYPO_AUTORESOLVE=0.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { damerauLevenshteinDistance } from "../integrity.js";
import { isRealWordOrName } from "./commonWords.js";

const scope = new AsyncLocalStorage();

export function typoAutoResolveEnabled() {
  return Boolean(scope.getStore()) && process.env.DONOVAN_TYPO_AUTORESOLVE !== "0";
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pure policy. `candidate` = the single fuzzy row, `universe` = every customer row of the tenant ({customer_name}). */
export function decideTypoResolution(typedPhrase, candidate, universe) {
  const typed = norm(typedPhrase);
  const candName = norm(candidate?.customer_name);
  if (!typed || !candName || typed === candName) return { ok: false, why: "not-a-typo" };
  const tt = typed.split(" ");
  const ct = candName.split(" ");
  if (tt.length < 2 || tt.length > 3 || tt.length !== ct.length) return { ok: false, why: "shape" };
  let total = 0;
  const known = new Set();
  for (const u of universe ?? []) for (const w of norm(u.customer_name).split(" ")) if (w) known.add(w);
  for (let i = 0; i < tt.length; i += 1) {
    const a = tt[i];
    const b = ct[i];
    if (a === b) continue;
    if (a.length < 4 || b.length < 4) return { ok: false, why: "short-word" };
    const limit = Math.min(a.length, b.length) < 6 ? 1 : 2;
    const d = damerauLevenshteinDistance(a, b);
    if (d > limit) return { ok: false, why: "token-distance" };
    total += d;
    if (isRealWordOrName(a)) return { ok: false, why: "real-word" };
    if (known.has(a)) return { ok: false, why: "other-customers-word" };
  }
  if (total === 0 || total > 2) return { ok: false, why: "total-distance" };
  if (damerauLevenshteinDistance(typed, candName) > 2) return { ok: false, why: "full-distance" };
  for (const u of universe ?? []) {
    const un = norm(u.customer_name);
    if (!un || un === candName) continue;
    if (Math.abs(un.length - typed.length) > 3) continue;
    if (damerauLevenshteinDistance(typed, un) <= 3) return { ok: false, why: "another-customer-close" };
  }
  return { ok: true, why: "unambiguous" };
}

/** True when the question quotes the typed phrase — the one-tap "as typed" re-ask. */
export function isQuotedAsTyped(question, typedPhrase) {
  if (!typedPhrase) return false;
  return new RegExp(`["“”]\\s*${esc(String(typedPhrase).trim())}\\s*["“”]`, "i").test(String(question ?? ""));
}

/**
 * The note for a technician-name correction {from, to} made by vocab/tenantVocab.js (the captured phrase can carry trailing
 * words: "Denny Ochoa done" -> "Danny Ochoa done"): find the technician's full name inside `to`, and the same span in `from`.
 */
export function techNoteFromCorrection(corr, technicianNames) {
  const to = String(corr?.to ?? "");
  const from = String(corr?.from ?? "");
  for (const name of technicianNames ?? []) {
    const at = to.toLowerCase().indexOf(String(name).toLowerCase());
    if (at < 0) continue;
    const typed = from.slice(at, at + String(name).length);
    if (typed && typed.toLowerCase() !== String(name).toLowerCase()) return { typed, resolved: String(name) };
  }
  return null;
}

/** Record that the current request resolved `typed` to `resolved` (no-op outside a scope). */
export function recordTypoResolution(typed, resolved) {
  const s = scope.getStore();
  if (s && !s.note) s.note = { typed: String(typed), resolved: String(resolved) };
}

export function typoNoteText(note) {
  return `Showing results for ${note.resolved} (you typed "${note.typed}").`;
}

/** Attach the note to an answer (idempotent). Returns the same object. */
export function decorateWithTypoNote(answer, note) {
  if (!answer || typeof answer !== "object" || !note || typeof answer.text !== "string") return answer;
  if (answer.typoResolution) return answer;
  answer.text = `${typoNoteText(note)} ${answer.text}`;
  answer.typoResolution = { typed: note.typed, resolved: note.resolved };
  return answer;
}

/**
 * Run `fn` (a lookup engine entry) inside a fresh scope; if it resolved a typo'd name and returned an answer, attach the
 * visible note to THAT answer. A null result (the engine deferred) discards the note.
 */
export async function withTypoNote(fn) {
  const store = { note: null };
  const result = await scope.run(store, fn);
  return store.note ? decorateWithTypoNote(result, store.note) : result;
}
