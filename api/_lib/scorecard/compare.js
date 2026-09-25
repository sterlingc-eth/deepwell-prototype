/**
 * Donovan Scorecard - pure answer comparators. No DB, no model, no clock.
 *
 * Each exam question carries an ORACLE (a small independent SQL query over the base tables, run by
 * oracle.js) and a comparison type. This file turns (oracle rows, Donovan's answer) into a verdict:
 *
 *   number      the primary number in the answer equals the oracle's count exactly
 *   set         precision and recall against the oracle's list of names/serials/"label|n" pairs, both >= 0.9
 *   value       a normalized string / date / phone / status match against one or more accepted values;
 *               an expected NULL means "the data does not have it": the same rule as honest-zero
 *   yesno       the answer commits to yes or no and matches the oracle's boolean
 *   honest-zero the records cannot answer: pass only if Donovan does not fabricate one (no facts, no
 *               invented figure)
 *   rubric      free text; graded by ONE cheap model call (grader.js) - the verdict comes from there
 *
 * CITATIONS: every verdict also carries `cited` (did the answer bring at least one citation / source / drill-down
 * record?) and `valueOk` (was the value itself right?). A question passes only when BOTH hold, unless it is tagged
 * `citationRequired: false` or its expected answer is itself empty (zero / no / not on file / an honest decline):
 * there is nothing to cite for "none". The run summary reports value accuracy and citation coverage separately.
 *
 * ALTERNATE DEFINITIONS: some questions have two defensible readings ("documents added" by upload date or by
 * service date). `alts` = [{expected, says}] accepts the second reading ONLY when the answer STATES which one it
 * used (`says`: a lowercase substring, or "re:<regex>"), so a lucky number that does not say what it counted fails.
 *
 * Nothing here logs anything; the summaries it returns are short and go to the operator's own scorecard.
 */

const MAX_SUMMARY = 300;

/* ------------------------------------------------------------------ answer view */

/** A flat view of an /api/ask `data` payload: text, facts and one normalized haystack. */
export function answerView(data) {
  const d = data && typeof data === "object" ? data : {};
  const facts = (Array.isArray(d.facts) ? d.facts : [])
    .filter((f) => f && typeof f === "object")
    .map((f) => ({ label: String(f.label ?? ""), value: String(f.value ?? "") }));
  const text = typeof d.text === "string" ? d.text : "";
  const factText = facts.map((f) => `${f.label} ${f.value}`);
  return {
    kind: typeof d.kind === "string" ? d.kind : "unknown",
    text,
    facts,
    factText,
    haystack: norm([text, ...factText].join(" \n ")),
    sources: Array.isArray(d.sources) ? d.sources.length : 0,
    citations: countCitations(d),
  };
}

/**
 * How many citations an /api/ask payload carries. Accepted shapes (any one is enough):
 *   data.sources[] | data.citations[] | data.records[] (drill-down list for aggregates) | data.drillDown / data.drilldown
 *   facts[].sources[] | facts[].citations[] | facts[].records[] | facts[].documentId / facts[].entityId (a record the fact points at)
 */
export function countCitations(d) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== "").length : 0);
  let n = arr(d.sources) + arr(d.citations) + arr(d.records) + arr(d.drillDown) + arr(d.drilldown) + arr(d.drill_down);
  for (const f of Array.isArray(d.facts) ? d.facts : []) {
    if (!f || typeof f !== "object") continue;
    n += arr(f.sources) + arr(f.citations) + arr(f.records);
    if (typeof f.documentId === "string" && f.documentId) n += 1;
  }
  return n;
}

/** Lowercase, drop punctuation, collapse whitespace. Dates and phone numbers are handled separately. */
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9À-ɏ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const digitsOnly = (s) => String(s ?? "").replace(/\D+/g, "");

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** Every date an answer mentions, as YYYY-MM-DD ("Sep 10, 2026", "9/10/2026", "2026-09-10", "10 September 2026"). */
export function datesIn(s) {
  const out = new Set();
  const t = String(s ?? "");
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.add(`${m[3]}-${pad(m[1])}-${pad(m[2])}`);
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/g)) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) out.add(`${m[3]}-${pad(mo)}-${pad(m[2])}`);
  }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9}),? (\d{4})\b/g)) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) out.add(`${m[3]}-${pad(mo)}-${pad(m[1])}`);
  }
  return out;
}

/** Numbers in a string, ignoring ones inside dates/zips/phones-ish tokens is NOT attempted: callers pick the slot. */
function numbersIn(s) {
  return [...String(s ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

const NUMBER_WORDS = { zero: 0, no: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

const clip = (s, n = MAX_SUMMARY) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "kind: text | label=value; label=value ..." - what Donovan said, in <= 300 chars. */
export function summarizeAnswer(view) {
  const facts = view.facts.slice(0, 4).map((f) => `${f.label}=${f.value}`).join("; ");
  const more = view.facts.length > 4 ? ` (+${view.facts.length - 4} more)` : "";
  return clip(`${view.kind}: ${view.text}${facts ? ` | ${facts}${more}` : ""}`);
}

/** Answers that decline / say nothing was found - the honest-zero shapes. */
const REFUSAL_RE = /\b(?:no|not|none|nothing|nobody|cannot|can't|cant|couldn't|unable|isn't|aren't|doesn't|don't|didn't|haven't|hasn't|zero|unknown|yet|unavailable)\b/i;


/* ------------------------------------------------------------------ comparators */

function compareNumber(expected, view, question, opts = {}) {
  const want = Number(expected);
  const qNums = new Set(numbersIn(question));
  if (view.kind === "no-answer") return { passed: false, score: 0, got: summarizeAnswer(view), why: "no answer" };
  const textNums = numbersIn(view.text).filter((n) => !qNums.has(n));
  const factNums = view.facts.length ? numbersIn(view.facts[0].value).filter((n) => !qNums.has(n)) : [];
  const word = (view.text.toLowerCase().match(/\b(zero|none|no|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/) ?? [])[1];
  const candidates = [textNums[0], factNums[0], word !== undefined ? NUMBER_WORDS[word] : undefined].filter((n) => n !== undefined);
  // Money and other "the figure is one of several numbers in a sentence" questions: any number in the answer may be the figure.
  if (opts.anyNumber) {
    candidates.push(...textNums, ...view.facts.flatMap((f) => numbersIn(f.value).filter((n) => !qNums.has(n))));
  }
  const tol = Number.isFinite(opts.tolerance) ? Math.max(0, opts.tolerance) : 0;
  let passed = candidates.some((n) => Math.abs(n - want) <= tol);
  // Zero: "nothing matches" with no facts is a correct zero.
  if (!passed && want === 0 && view.facts.length === 0 && (view.text === "" || REFUSAL_RE.test(view.text))) passed = true;
  // A list answer that returned exactly `want` facts is a correct count.
  if (!passed && view.facts.length === want && want > 1 && textNums.length === 0) passed = true;
  let usedAlt = null;
  // A second defensible definition counts only when the answer says it used it.
  if (!passed) {
    for (const alt of opts.alts ?? []) {
      const a = Number(alt.expected);
      if (candidates.some((n) => Math.abs(n - a) <= tol) || (a === 0 && view.facts.length === 0 && REFUSAL_RE.test(view.text)))
        if (statesDefinition(view, alt.says)) { passed = true; usedAlt = String(alt.says ?? ""); break; }
    }
  }
  return { passed, score: passed ? 1 : 0, got: summarizeAnswer(view), why: passed ? (usedAlt ? `accepted alternate definition (${usedAlt})` : "") : `expected ${want}`, ...(usedAlt ? { usedAlt } : {}) };
}

/** Does the answer state the definition an alternate reading needs? `says` is a lowercase substring, or "re:<regex>". No `says` = never. */
export function statesDefinition(view, says) {
  const s = String(says ?? "").trim();
  if (!s) return false;
  const hay = `${view.text} ${view.factText.join(" ")}`.toLowerCase();
  if (s.startsWith("re:")) { try { return new RegExp(s.slice(3), "i").test(hay); } catch { return false; } }
  return hay.includes(s.toLowerCase()) || norm(hay).includes(norm(s));
}

/** Does `item` ("name" or "label|n") appear in the answer? Parts of a "a|b" item must share one fact (or the text). */
function itemPresent(item, view) {
  const parts = String(item).split("|").map(norm).filter(Boolean);
  if (!parts.length) return false;
  const inOne = (hay) => parts.every((p) => hasToken(hay, p));
  if (view.factText.some((f) => inOne(norm(f)))) return true;
  return inOne(norm(view.text)) || (view.facts.length === 0 && inOne(view.haystack));
}

function hasToken(hay, needle) {
  if (!needle) return false;
  return new RegExp(`(?:^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(hay);
}

function compareSet(expectedItems, view) {
  const expected = [...new Set((expectedItems ?? []).map((s) => String(s)).filter(Boolean))];
  if (!expected.length) {
    const declined = view.kind === "no-answer" || view.facts.length === 0;
    return { passed: declined, score: declined ? 1 : 0, precision: declined ? 1 : 0, recall: 1, got: summarizeAnswer(view), why: declined ? "" : "expected an empty list" };
  }
  if (view.kind === "no-answer") return { passed: false, score: 0, precision: 0, recall: 0, got: summarizeAnswer(view), why: "no answer" };
  const found = expected.filter((e) => itemPresent(e, view));
  const recall = found.length / expected.length;
  // Precision: of the facts returned (skipping pure totals), how many match an expected item.
  const graded = view.facts.filter((f) => !/^\s*[\d,.]+\s*$/.test(f.value) || !/\b(?:total|count|number|customers?|units?|documents?)\b/i.test(f.label));
  const rows = graded.filter((f) => !/^(?:total|count|number of)\b/i.test(f.label));
  let precision = 1;
  if (rows.length) {
    const right = rows.filter((f) => expected.some((e) => {
      const parts = String(e).split("|").map(norm).filter(Boolean);
      const hay = norm(`${f.label} ${f.value}`);
      return parts.every((p) => hasToken(hay, p));
    }));
    precision = right.length / rows.length;
  }
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const passed = recall >= 0.9 && precision >= 0.9;
  return {
    passed, score: Math.round(f1 * 1000) / 1000, precision: Math.round(precision * 1000) / 1000, recall: Math.round(recall * 1000) / 1000,
    got: summarizeAnswer(view), why: passed ? "" : `recall ${Math.round(recall * 100)}%, precision ${Math.round(precision * 100)}%`,
  };
}

/** warranty wording -> 'expired' | 'active' | 'expiring' | 'unknown' | null (not a warranty statement) */
export function warrantyStatusFromText(text) {
  const t = norm(text);
  if (!t) return null;
  if (/\b(?:expired|out of warranty|no longer (?:under|in|covered)|not (?:under|in) warranty|not covered|lapsed|past warranty|off warranty)\b/.test(t)) return "expired";
  if (/\b(?:expiring|expires soon|about to expire|expires in)\b/.test(t)) return "expiring";
  if (/\b(?:unknown|no warranty (?:\w+ ){0,2}(?:on file|information|info|record|recorded|data|details?|found)|no (?:warranty )?(?:expiration|expiry|end|coverage) (?:date )?(?:on file|recorded|found|listed)|warranty (?:\w+ ){0,2}(?:not|isnt|isn t) (?:on file|recorded|listed|available)|cannot tell|cant tell|can t tell|not able to tell|no expiration|not on file|not recorded|not listed|no record of (?:a )?warranty)\b/.test(t)) return "unknown";
  if (/\b(?:active|still (?:under|in) warranty|under warranty|in warranty|covered|current)\b/.test(t)) return "active";
  return null;
}

function compareValue(expected, view) {
  const alts = (Array.isArray(expected) ? expected : [expected]).filter((v) => v !== null && v !== undefined && String(v) !== "");
  if (!alts.length) return compareHonestZero(view, "value not on file");
  if (view.kind === "no-answer") return { passed: false, score: 0, got: summarizeAnswer(view), why: "no answer" };
  const dates = datesIn(`${view.text} ${view.factText.join(" ")}`);
  const digitHay = digitsOnly(`${view.text} ${view.factText.join(" ")}`);
  let passed = false;
  for (const alt of alts) {
    const a = String(alt);
    if (/^(?:expired|active|expiring|unknown)$/.test(a)) {
      const got = warrantyStatusFromText(`${view.text} ${view.factText.join(" ")}`);
      if (got === a) { passed = true; break; }
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { if (dates.has(a)) { passed = true; break; } continue; }
    if (/^[\d\s().+-]{7,}$/.test(a) && digitsOnly(a).length >= 7) { if (digitHay.includes(digitsOnly(a))) { passed = true; break; } continue; }
    if (hasToken(view.haystack, norm(a))) { passed = true; break; }
  }
  return { passed, score: passed ? 1 : 0, got: summarizeAnswer(view), why: passed ? "" : "expected value not in the answer" };
}

/**
 * TEAM F (scorecard correctness, 2026-09-24): "how many invoices are unpaid/paid/overdue/partial" - most
 * invoices print no payment status at all, so the KNOWN count alone is a misleading thing to state baldly
 * ("0 invoices are unpaid" reads as "definitely none" when the truth is "1 shows a status; the other 67
 * don't say"). expected = {known, unknown} (oracle columns n / u). Pass requires the KNOWN number (same
 * matching as compareNumber) AND, whenever unknown > 0, that the answer actually says so - a plain
 * confident number with no such acknowledgement fails even though the number itself is right.
 */
function compareCountWithUnknown(expected, view, question, opts = {}) {
  const known = Number(expected?.known) || 0;
  const unknown = Math.max(0, Number(expected?.unknown) || 0);
  const base = compareNumber(known, view, question, opts);
  if (!base.passed || unknown <= 0) return base;
  const mentionsUnknown =
    /\b(?:unknown|unclear|(?:don'?t|doesn'?t|can'?t|cannot) (?:show|print|say|indicate|record|have|track|tell)|not (?:shown|indicated|recorded|printed|captured|on file|available|known)|no (?:printed|recorded|listed)? ?status|status is not|no way to (?:tell|know))\b/i.test(view.text) ||
    numbersIn(view.text).includes(unknown);
  if (!mentionsUnknown) {
    return { ...base, passed: false, why: `states ${known} with no mention of the ${unknown} invoice(s) whose status is not on file` };
  }
  return base;
}

function compareYesNo(expected, view) {
  const want = expected === true || expected === "yes" || expected === "true";
  const first = norm(view.text).split(" ").slice(0, 6).join(" ");
  let said = null;
  if (/^(?:yes|yeah|yep|correct|absolutely|there (?:is|are)|we do|you do|they do|it (?:is|does)|we have|you have|he does|she does)\b/.test(first)) said = true;
  else if (/^(?:no|nope|not|nothing|none|there (?:is|are) no|we dont|you dont|we havent|you havent|we did not|no records)\b/.test(first)) said = false;
  if (said === null) {
    const f0 = view.facts[0] ? norm(view.facts[0].value) : "";
    if (/^(?:yes|true)\b/.test(f0)) said = true;
    else if (/^(?:no|false)\b/.test(f0)) said = false;
  }
  if (said === null) {
    if (view.kind === "no-answer") return { passed: false, score: 0, got: summarizeAnswer(view), why: "no answer" };
    said = view.facts.length > 0 && !/\b(?:no |not |none|nothing)\b/.test(norm(view.text));
  }
  const passed = said === want;
  return { passed, score: passed ? 1 : 0, got: summarizeAnswer(view), why: passed ? "" : `expected ${want ? "yes" : "no"}` };
}

function compareHonestZero(view, why = "the records cannot answer this") {
  const fabricated = view.kind !== "no-answer" && (view.facts.length > 0 || /[$]\s*\d/.test(view.text));
  return { passed: !fabricated, score: fabricated ? 0 : 1, got: summarizeAnswer(view), why: fabricated ? `fabricated an answer (${why})` : "" };
}

/** Is there anything for a citation to point at? "0", "no", "not on file", an empty list and an honest decline have no source. */
export function isSubstantive(q) {
  switch (q.cmp) {
    case "number": return Number(q.expected) > 0;
    case "count-with-unknown": return Number(q.expected?.known) > 0 || Number(q.expected?.unknown) > 0;
    case "set": return Array.isArray(q.expected) && q.expected.length > 0;
    case "value": return (Array.isArray(q.expected) ? q.expected : [q.expected]).some((v) => v !== null && v !== undefined && String(v) !== "");
    case "yesno": return q.expected === true || q.expected === "yes" || q.expected === "true";
    case "rubric": return Array.isArray(q.expected) ? q.expected.length > 0 : Boolean(q.expected);
    default: return false;
  }
}

/** Does this question need a citation for a pass? (default yes, when the right answer is a substantive one) */
export function citationRequiredFor(q) {
  return q.citationRequired !== false && isSubstantive(q);
}

/**
 * @param {{cmp: 'number'|'set'|'value'|'yesno'|'honest-zero', expected: any, question?: string, citationRequired?: boolean,
 *   alts?: {expected: any, says: string}[], tolerance?: number, anyNumber?: boolean}} q
 * @param {object} data  the /api/ask response `data`
 * @returns {{passed: boolean, valueOk: boolean, cited: boolean, citationRequired: boolean, score: number, got: string, expectedSummary: string, why: string, precision?: number, recall?: number}}
 */
export function compareAnswer(q, data) {
  const view = answerView(data);
  let r;
  switch (q.cmp) {
    case "number": r = compareNumber(q.expected, view, q.question, { alts: q.alts, tolerance: q.tolerance, anyNumber: q.anyNumber }); break;
    case "count-with-unknown": r = compareCountWithUnknown(q.expected, view, q.question, { tolerance: q.tolerance, anyNumber: q.anyNumber }); break;
    case "set": r = compareSet(q.expected, view); break;
    case "value": r = compareValue(q.expected, view); break;
    case "yesno": r = compareYesNo(q.expected, view); break;
    case "honest-zero": r = compareHonestZero(view); break;
    default: throw new Error(`compareAnswer: unsupported comparison ${String(q.cmp)}`);
  }
  return withCitation(r, q, view);
}

/** Fold the citation check into a value verdict: pass = value right AND (cited OR no citation needed). */
export function withCitation(r, q, view) {
  const valueOk = Boolean(r.passed);
  const citationRequired = citationRequiredFor(q);
  const cited = view.citations > 0;
  const passed = valueOk && (!citationRequired || cited);
  const why = valueOk && !passed ? "right value, but no citation or source" : r.why;
  return { ...r, passed, valueOk, cited, citationRequired, why, expectedSummary: summarizeExpected(q) };
}

export function summarizeExpected(q) {
  switch (q.cmp) {
    case "number": return (q.alts ?? []).length ? clip(`${q.expected} (or ${q.alts.slice(0, 3).map((x) => `${x.expected} if it says "${String(x.says).replace(/^re:/, "")}"`).join("; ")})`) : String(q.expected);
    case "count-with-unknown": return `${q.expected?.known ?? 0}${Number(q.expected?.unknown) > 0 ? ` (+ ${q.expected.unknown} unknown - must be mentioned)` : ""}`;
    case "set": {
      const items = q.expected ?? [];
      return clip(`${items.length} item(s): ${items.slice(0, 6).join("; ")}${items.length > 6 ? "; …" : ""}`);
    }
    case "value": {
      const alts = (Array.isArray(q.expected) ? q.expected : [q.expected]).filter((v) => v !== null && v !== undefined && String(v) !== "");
      return alts.length ? clip(alts.slice(0, 3).join(" / ")) : "no answer on file (must not invent one)";
    }
    case "yesno": return q.expected === true || q.expected === "yes" ? "yes" : "no";
    case "honest-zero": return "cannot be answered from the records (must not invent one)";
    case "rubric": return clip(`graded: ${q.rubric ?? ""}`);
    default: return "";
  }
}

/**
 * Pure: turn an oracle's rows into the `expected` value for a comparison type.
 * Conventions (the exam generator follows them): number -> first column of row 1; set -> column `item`
 * of every row; value -> column `v` of every row (alternatives); yesno -> column `v` of row 1;
 * honest-zero -> nothing; rubric -> column `ref` lines (reference material for the grader).
 * Returns {skip: true, why} for an honest-zero whose guard says the data now exists.
 */
export function expectedFromRows(cmp, rows) {
  const r = Array.isArray(rows) ? rows : [];
  const first = r[0] ?? {};
  switch (cmp) {
    case "number": {
      const v = first[Object.keys(first)[0]];
      const n = Number(v);
      return { expected: Number.isFinite(n) ? n : 0 };
    }
    case "count-with-unknown": {
      const known = Number(first.n); const unknown = Number(first.u);
      return { expected: { known: Number.isFinite(known) ? known : 0, unknown: Number.isFinite(unknown) ? unknown : 0 } };
    }
    case "set": return { expected: r.map((x) => x.item).filter((x) => x !== null && x !== undefined && String(x) !== "").map(String) };
    case "value": return { expected: r.map((x) => x.v).filter((x) => x !== null && x !== undefined && String(x) !== "").map(String) };
    case "yesno": return { expected: first.v === true || first.v === "t" || first.v === "true" || first.v === 1 };
    case "honest-zero": return { expected: null, dataExists: Number(first.n ?? 0) > 0 };
    case "rubric": return { expected: r.map((x) => x.ref).filter(Boolean).map(String) };
    default: throw new Error(`expectedFromRows: unsupported comparison ${String(cmp)}`);
  }
}

/**
 * Pure: nearest-rank percentile (p in [0,100]) over a list of numbers. Sorts a copy; empty input -> null.
 * "Nearest rank" (not interpolated) so the reported number is always one that was actually observed.
 */
export function percentile(values, p) {
  const nums = (values ?? []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const rank = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[rank];
}

/** TEAM F (speed/scorecard correctness): p50/p95 latency (ms) over a set of per-question results. */
export function latencyStats(results) {
  const ms = (results ?? []).filter((r) => r && !r.skipped).map((r) => Number(r.latencyMs)).filter((n) => Number.isFinite(n) && n >= 0);
  return { n: ms.length, p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95) };
}

/** Pure: 1-decimal-rounded average of a list of numbers (nulls/NaN skipped), or null when there are none. */
function avg(nums) {
  const list = (nums ?? []).filter((n) => Number.isFinite(n));
  return list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 1000) / 1000 : null;
}

/**
 * Pure: overall and per-category score from per-question results (skipped ones are excluded).
 * `score` = share that passed (value right AND cited when a citation is required); `valueScore` = share whose
 * value was right, citations aside; `citation` = of the answers that needed a citation, how many carried one.
 *
 * TEAM T3 (2026-09-25) quality metrics beyond pass/fail, all pulled from fields the runner already stores
 * per question (never a second pass over the DB):
 *   citation.precisionAvg / unsupportedClaimRate  - citationCheck.js's text-match precision (detail.citationPrecision),
 *     averaged over answers it could actually check; unsupportedClaimRate is simply 1 - precisionAvg.
 *   completeness.recallAvg  - average list recall (detail.recall, already set for every "set"-comparison
 *     question by compareSet/withCitation above) - "did the answer name everything the oracle expected".
 *   avgCostUsd  - mean per-question spend (costUsd), overall and per category.
 *   latencyByComparison  - p50/p95 latency bucketed by comparison type (number/set/value/yesno/rubric/...):
 *     the scorecard has no true request-route label to bucket by (askCall.js's `debug` trace only exists
 *     for agent-answered questions), so the comparison type - which correlates with which pre-router or
 *     model path a question tends to take - is used as the nearest available proxy. Documented here rather
 *     than overclaimed as a literal route.
 */
export function scoreResults(results) {
  const graded = (results ?? []).filter((r) => r && !r.skipped);
  const by = {};
  const cite = { required: 0, cited: 0 };
  let valueOk = 0;
  const citePrecisionAll = [];
  const recallAll = [];
  const costAll = [];
  const byComparison = {};
  for (const r of graded) {
    const c = (by[r.category] ??= { passed: 0, total: 0, valueOk: 0, citeRequired: 0, cited: 0, citationPrecisions: [], recalls: [], costs: [] });
    c.total += 1;
    if (r.passed) c.passed += 1;
    // Results stored before citation scoring have no valueOk: their pass IS the value verdict.
    const v = r.valueOk === undefined ? Boolean(r.passed) : Boolean(r.valueOk);
    if (v) { c.valueOk += 1; valueOk += 1; }
    if (r.citationRequired) { c.citeRequired += 1; cite.required += 1; if (r.cited) { c.cited += 1; cite.cited += 1; } }
    const cp = r.detail?.citationPrecision;
    if (typeof cp === "number") { c.citationPrecisions.push(cp); citePrecisionAll.push(cp); }
    const rc = r.detail?.recall;
    if (typeof rc === "number") { c.recalls.push(rc); recallAll.push(rc); }
    const cost = Number(r.costUsd);
    if (Number.isFinite(cost)) { c.costs.push(cost); costAll.push(cost); }
    if (r.comparison) {
      const cm = (byComparison[r.comparison] ??= []);
      if (Number.isFinite(Number(r.latencyMs))) cm.push(Number(r.latencyMs));
    }
  }
  for (const c of Object.values(by)) {
    c.score = c.total ? Math.round((c.passed / c.total) * 1000) / 1000 : 0;
    c.valueScore = c.total ? Math.round((c.valueOk / c.total) * 1000) / 1000 : 0;
    c.citationCoverage = c.citeRequired ? Math.round((c.cited / c.citeRequired) * 1000) / 1000 : null;
    c.citationPrecisionAvg = avg(c.citationPrecisions);
    c.recallAvg = avg(c.recalls);
    c.avgCostUsd = c.costs.length ? Math.round(avg(c.costs) * 100000) / 100000 : null;
    delete c.citationPrecisions; delete c.recalls; delete c.costs;
  }
  const passed = graded.filter((r) => r.passed).length;
  const precisionAvg = avg(citePrecisionAll);
  return {
    total: graded.length, passed, score: graded.length ? Math.round((passed / graded.length) * 10000) / 10000 : null,
    valueScore: graded.length ? Math.round((valueOk / graded.length) * 10000) / 10000 : null,
    citation: {
      required: cite.required, cited: cite.cited, coverage: cite.required ? Math.round((cite.cited / cite.required) * 10000) / 10000 : null,
      precisionAvg, unsupportedClaimRate: precisionAvg == null ? null : Math.round((1 - precisionAvg) * 1000) / 1000, checked: citePrecisionAll.length,
    },
    completeness: { recallAvg: avg(recallAll), n: recallAll.length },
    avgCostUsd: costAll.length ? Math.round(avg(costAll) * 100000) / 100000 : null,
    byCategory: by,
    latency: latencyStats(graded),
    latencyByComparison: Object.fromEntries(Object.entries(byComparison).map(([k, ms]) => [k, { n: ms.length, p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95) }])),
  };
}
