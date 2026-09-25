/**
 * Donovan agent — turn the agent's final `answer` tool input into the response
 * shape /api/ask already returns and the UI already renders (kind 'answer' |
 * 'no-answer', facts[], sources[], ...). No new kind is invented:
 *
 *   - document-grounded facts (fact.sources) go through answer.js's shapeAnswer
 *     with `allowed` built by buildAllowed() from exactly the documents / pages /
 *     fields the tools RETURNED in this run (EvidenceLedger). A citation nothing
 *     returned is dropped — same guarantee the retrieval path has.
 *   - aggregate / list facts with no document (counts, "who all" lists) are the
 *     same unsourced-fact shape analytics.js's formatAnalyticsAnswer already
 *     produces (FactGrid renders them). Because nothing cites them, each must
 *     instead be BACKED by the tool output: every number-bearing token in its
 *     value must literally appear in what the model was shown, and its label/
 *     value (or entityId) must match something shown. Otherwise it is dropped.
 *   - `text` never passes unless at least one fact (or a real empty result for
 *     status 'none_found') backs it; numbers in it must appear in the tool output
 *     or the question, else it is rewritten deterministically from the facts.
 *   - anything that leaves nothing is the honest no-answer (NO_ANSWER_TEXT).
 */
import { buildAllowed, shapeAnswer, NO_ANSWER_TEXT } from "../answer.js";

const NONE_FOUND_TEXT = "Nothing in your records matches that.";
const STATUSES = new Set(["ok", "warn", "bad", "info", "muted"]);
/** A list answer returns every row up to this cap (live defect: a 13-customer list was cut to 5). */
export const MAX_FACTS = 40;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Tokens that carry a digit ("1,250.00", "2026-09-14", "GSX140361K", "85201"). */
function digitTokens(s) {
  return (String(s).toLowerCase().match(/[a-z0-9$#][a-z0-9$#.,:/-]*/g) ?? [])
    .map((tok) => tok.replace(/[.,:/-]+$/, ""))
    .filter((tok) => /\d/.test(tok));
}

function inCorpus(token, corpus, corpusNoComma) {
  const variants = new Set([token, token.replace(/,/g, ""), token.replace(/^[$#]/, ""), token.replace(/^[$#]/, "").replace(/,/g, "")]);
  for (const v of variants) {
    if (!v) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(v)}(?![a-z0-9])`);
    if (re.test(corpus) || re.test(corpusNoComma)) return true;
  }
  return false;
}

function wholeWordIn(corpus, w) { return new RegExp(`(?<![a-z])${escapeRe(w)}(?![a-z])`).test(corpus); }

function wordsIn(corpus, s) {
  const words = String(s).toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return words.some((w) => corpus.includes(w));
}

/**
 * @param {any} raw     the model's final `answer` tool input (untrusted)
 * @param {import("./tools.js").EvidenceLedger} ledger
 * @param {{question?: string, today?: string}} [ctx]
 * @returns {{data: object, answered: boolean, dropped: {facts: number, sources: number, entityIds: number, textRewritten: boolean}}}
 */
export function shapeAgentAnswer(raw, ledger, { question = "", today = "" } = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const status = input.status === "answered" || input.status === "none_found" || input.status === "cannot_answer" ? input.status : "cannot_answer";
  const dropped = { facts: 0, sources: 0, entityIds: 0, textRewritten: false };

  const noAnswer = () => ({
    data: { kind: "no-answer", text: NO_ANSWER_TEXT, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] },
    answered: false, dropped,
  });

  if (status === "cannot_answer") return noAnswer();

  const evidence = ledger.corpus;
  const corpus = `${evidence}\n${String(question).toLowerCase()}\n${String(today).toLowerCase()}`;
  const corpusNoComma = corpus.replace(/,/g, "");
  const evidenceNoComma = evidence.replace(/,/g, "");

  const allowed = buildAllowed(ledger.allowedInput());
  const validRawFacts = (Array.isArray(input.facts) ? input.facts : [])
    .filter((f) => f && typeof f === "object" && typeof f.label === "string" && typeof f.value === "string" && f.label.trim() && f.value.trim());
  const rawFacts = validRawFacts.slice(0, MAX_FACTS);
  const overflow = Math.max(0, validRawFacts.length - MAX_FACTS);

  const sourcedIn = [];
  const unsourcedOk = [];
  for (const f of rawFacts) {
    const sources = (Array.isArray(f.sources) ? f.sources : [])
      .filter((s) => s && typeof s === "object" && typeof s.documentId === "string")
      .map((s) => {
        const docId = s.documentId.toLowerCase();
        const loc = s.location && typeof s.location === "object" && (typeof s.location.page === "number" || (typeof s.location.field === "string" && s.location.field))
          ? s.location
          : { field: "document" };
        const filename = ledger.docName.get(docId);
        return { documentId: docId, location: loc, ...(filename ? { filename } : {}) };
      });

    let entityId = typeof f.entityId === "string" ? f.entityId.toLowerCase() : undefined;
    if (entityId && !ledger.ids.has(entityId)) { entityId = undefined; dropped.entityIds++; }
    const st = typeof f.status === "string" && STATUSES.has(f.status) ? f.status : undefined;
    const base = { label: f.label.trim().slice(0, 120), value: f.value.trim().slice(0, 300), ...(st ? { status: st } : {}), ...(entityId ? { entityId } : {}) };

    if (sources.length) {
      sourcedIn.push({ ...base, sources });
      continue;
    }
    // Unsourced (aggregate / list) fact: must be backed by what the tools returned.
    const numericOk = digitTokens(base.value).every((tok) => inCorpus(tok, evidence, evidenceNoComma));
    // Capitalised words (names, cities, statuses) must also come from what the tools returned.
    const wordsOk = (base.value.match(/\b[A-Z][A-Za-z]{2,}/g) ?? []).map((w) => w.toLowerCase()).every((w) => wholeWordIn(evidence, w) || (w.endsWith("s") && wholeWordIn(evidence, w.slice(0, -1))));
    const anchored = Boolean(entityId) || wordsIn(evidence, `${base.label} ${base.value}`) || (digitTokens(base.value).length > 0 && numericOk);
    if (numericOk && wordsOk && anchored && ledger.dataCalls > 0) unsourcedOk.push({ ...base, sources: [] });
    else dropped.facts++;
  }

  // Sourced facts: answer.js's own grounding (page / field must have been returned for that document).
  const shaped = shapeAnswer(
    { text: "x", facts: sourcedIn, confidence: 1 },
    allowed,
    { candidates: [...ledger.docStage.keys()].map((documentId) => ({ documentId })) }
  );
  const sourcedOk = shaped.kind === "answer" ? shaped.facts : [];
  dropped.facts += sourcedIn.length - sourcedOk.length;
  dropped.sources += sourcedIn.reduce((n, f) => n + f.sources.length, 0) - sourcedOk.reduce((n, f) => n + f.sources.length, 0);

  const facts = [...sourcedOk, ...unsourcedOk];

  if (!facts.length) {
    // An honest, evidence-backed zero: a tool ran and found nothing.
    if (status === "none_found" && ledger.emptyResults > 0) {
      const modelText = typeof input.text === "string" ? input.text.trim() : "";
      const numbersOk = modelText && digitTokens(modelText).every((tok) => inCorpus(tok, corpus, corpusNoComma));
      const text = numbersOk && modelText.length <= 300 ? modelText : NONE_FOUND_TEXT;
      if (text === NONE_FOUND_TEXT && modelText) dropped.textRewritten = true;
      return {
        data: { kind: "answer", text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
          ...(typeof input.interpretation === "string" && input.interpretation ? { interpretation: input.interpretation.slice(0, 160) } : {}) },
        answered: true, dropped,
      };
    }
    return noAnswer();
  }

  // Text: keep the model's sentence only if its numbers are in the evidence; else compose from facts.
  const modelText = typeof input.text === "string" ? input.text.trim() : "";
  const allowedNums = new Set([String(facts.length)]);
  const textNumsOk = digitTokens(modelText).every((tok) => allowedNums.has(tok) || inCorpus(tok, corpus, corpusNoComma));
  let text = modelText && modelText.length <= 400 && textNumsOk ? modelText : "";
  if (!text) {
    dropped.textRewritten = true;
    text = facts.length <= 3
      ? facts.map((f) => `${f.label}: ${f.value}`).join("; ") + "."
      : `Found ${facts.length} matching records; the full list is below.`;
  }
  // Completeness is never implied: the true total is always in the sentence, and a list that could
  // not be shown whole (more rows than fit / more facts than the cap) says exactly how much is shown.
  const lq = ledger.lastQuery;
  const rowsCut = lq && lq.shown < lq.rowCount && facts.length >= 2 ? lq.rowCount : 0;
  const totalRows = Math.max(rowsCut, facts.length + overflow);
  if (rowsCut || overflow) {
    text = `${text.replace(/[.\s]+$/, "")}. Showing ${facts.length} of ${totalRows}; ask me to narrow it down for the rest.`;
    dropped.truncated = true;
  } else if (facts.length >= 4 && digitTokens(text).length === 0) {
    // Only append a fact count when the sentence states NO number at all. When it already states one
    // (e.g. "13 customers have equipment under warranty") but that number differs from facts.length
    // (14 rows: one customer has two units), appending "14 in all" reads as a contradiction — a real
    // owner-reported defect (2026-09-25). The model's own number already passed textNumsOk above (it
    // must appear in the tool evidence), so it is trusted over a blind row count here.
    text = `${text.replace(/[.\s]+$/, "")}. ${facts.length} in all.`;
  }

  const citedDocIds = new Set(facts.flatMap((f) => f.sources.map((s) => s.documentId)));
  const verifiedCount = [...citedDocIds].filter((id) => allowed.stageByDoc?.get(id) === "verified").length;
  const conf = Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : 0.8;
  const topEntity = typeof input.entityId === "string" && ledger.ids.has(input.entityId.toLowerCase()) ? input.entityId.toLowerCase() : undefined;

  return {
    data: {
      kind: "answer",
      text,
      facts,
      sources: facts.flatMap((f) => f.sources),
      confidence: conf,
      ...(topEntity ? { entityId: topEntity } : {}),
      ...(typeof input.interpretation === "string" && input.interpretation ? { interpretation: input.interpretation.slice(0, 160) } : {}),
      verifiedCount,
      unverifiedCount: citedDocIds.size - verifiedCount,
      closest: [],
    },
    answered: true,
    dropped,
  };
}
