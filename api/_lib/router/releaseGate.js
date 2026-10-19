/**
 * releaseGate.js - the HANDOFF rule: when Donovan's own lanes (rules, learned reader, Reader V2) release a question, it goes to the Claude path.
 *
 *   A response that is about to be sent as kind "no-answer" is ESCALATED (agent / retrieval+model) unless it is one of these FINAL declines:
 *     - the lane verified the fact is absent from THIS company's records and said so (data.finalDecline = 'absent-*', or the older data.addressMiss flag);
 *     - a policy / privacy / safety refusal (data.finalDecline = 'policy' | 'private');
 *     - a how-to help answer (data.help), or an ambiguous-surname question that only the person can settle (clarify.reason = ambiguous-surname).
 *   Everything else (clarify chips for a recognised entity, "I couldn't match ...", "No purchase order X on file" from a narrower search, the generic
 *   "Nothing in your records answers that yet", a V2 release) is NOT final: Claude gets the question, and the decline is only the fallback.
 *
 * Pure. No database, no model, no question text is ever logged by this module.
 * Switch: DONOVAN_RELEASE_ESCALATION=0 turns the whole handoff off (the old behaviour). In-process scorecard / verify calls (hook.js) are exempt
 * unless the call carries releaseEscalation: true, so no offline suite spends a model call it did not ask for.
 */
export const releaseEscalationEnabled = (env = process.env) => env?.DONOVAN_RELEASE_ESCALATION !== "0";

const FINAL = new Set(["policy", "private", "absent-name", "absent-address", "absent-number", "absent-doctype", "absent-text"]);
/** Mark a decline the lane has VERIFIED (or a refusal that must stay a refusal). Returns the same object. */
export function markFinal(data, why) { if (data && typeof data === "object") data.finalDecline = FINAL.has(why) ? why : "policy"; return data; }
/** The marker is server-only. */
export function stripReleaseMarker(data) { if (data && typeof data === "object" && "finalDecline" in data) delete data.finalDecline; return data; }

export function isFinalDecline(data) {
  if (!data || typeof data !== "object") return false;
  if (data.finalDecline && FINAL.has(data.finalDecline)) return true;
  if (data.addressMiss === true) return true;
  if (data.help) return true;
  if (data.clarify === true && data.clarifyReason === "ambiguous-surname") return true;
  return false;
}

/** true when this body is a release that must be escalated. `touched` = a model path already ran for this request. */
export function isEscalatableRelease(data, { touched = false } = {}) {
  if (!data || typeof data !== "object" || data.kind !== "no-answer") return false;
  if (touched) return false;
  return !isFinalDecline(data);
}

/** A short, stable cause label for the log (and the training review file): which lane released the question. */
export function releaseCause(data) {
  if (!data || typeof data !== "object") return "unknown";
  if (data.clarify === true) return `clarify:${data.clarifyReason ?? "chips"}`;
  const t = String(data.text ?? "");
  if (/^I can't answer that exactly as worded/i.test(t)) return "clarify:recognised-entity";
  if (/^I don't have anyone named/i.test(t)) return "unknown-name";
  if (/^I couldn't (?:match|find) "/i.test(t)) return "name-fuzzy";
  if (/^No (?:purchase order|invoice|work order|permit|service ticket|quote|document)\b.* on file\.?$/i.test(t)) return "docnumber-no-match";
  if (/^Nothing in your records answers that yet/i.test(t)) return "honest-zero";
  if (/not in your business records/i.test(t)) return "off-domain";
  if (/^I don't have that stored for/i.test(t)) return "field-not-read";
  return "lane-decline";
}
