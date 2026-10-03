/**
 * "Internal memos" questions: a memo is found by what it IS (page text headed "INTERNAL MEMO", or audience = 'internal'),
 * never by whether it also names a customer (which keeps audience "customer" and used to yield a false "no internal memos on file").
 * Optional filters taken from the question: a name/topic phrase (must appear in the memo text) and an mm/dd/yyyy date.
 * Kill switch: DONOVAN_MEMO_AUDIENCE=0 restores the old behaviour.
 */
import { documentsHaveAudience } from "../audience/probe.js";
import { attachCitations, documentRecord } from "../citations/records.js";

export const memoAudienceEnabled = () => process.env.DONOVAN_MEMO_AUDIENCE !== "0";
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const STOP = new Set(["all", "techs", "tech", "technicians", "customers", "customer", "the", "any", "every", "each", "us", "our", "you", "team", "staff", "this", "that", "month", "week", "year", "today", "file", "on", "we", "have", "a", "an", "it", "them", "say", "says", "memo", "memos", "internal", "notes", "note", "sent", "from", "dispatch"]);
const norm = (s) => String(s ?? "").replace(/[’‘]/g, "'").toLowerCase();

export function memoFilters(question) {
  let q = String(question ?? "");
  const dm = q.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const date = dm ? `${dm[1].padStart(2, "0")}/${dm[2].padStart(2, "0")}/${dm[3]}` : null;
  q = q.replace(/\b(?:dated|from|on|of)?\s*\d{1,2}\/\d{1,2}\/\d{4}\b/g, " ");
  const m = q.match(/\b(?:about|regarding|concerning|mention(?:s|ing)?|re|for|naming|names?|involving)\s+(.+?)(?:\s+(?:say|says|said|dated|on file))?\s*[?.!]*\s*$/i);
  const toks = (m ? m[1] : "").toLowerCase().replace(/['’]s\b/g, "").match(/[a-z0-9]+/g) ?? [];
  const kept = toks.filter((t) => !STOP.has(t));
  return { date, terms: kept.length === toks.length ? kept : kept.length && kept.length >= 1 && toks.every((t) => STOP.has(t) || kept.includes(t)) ? kept : [] };
}

export async function answerInternalMemos(db, question) {
  if (!memoAudienceEnabled()) return null;
  if (!/\bmemos?\b/i.test(String(question ?? ""))) return null; // only literal "memo" questions; "internal notes / dispatch sent / staff-only" keep the audience-based path
  const hasCol = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename, d.created_at, string_agg(p.text, E'\\n' ORDER BY p.page_no) AS body
       FROM documents d JOIN document_pages p ON p.document_id = d.id AND p.${TENANT}
      WHERE d.${TENANT} AND (${hasCol ? "d.audience = 'internal' OR " : ""}EXISTS (SELECT 1 FROM document_pages q WHERE q.document_id = d.id AND q.${TENANT} AND q.text ~* '\\yinternal memo\\s+(?:date|to|from|re)\\y'))
      GROUP BY d.id, d.original_filename, d.created_at ORDER BY d.created_at DESC`
  );
  const all = rows.map((r) => {
    const body = String(r.body ?? "");
    const i = body.search(/internal memo/i);
    const memoText = (i >= 0 ? body.slice(i) : body).replace(/\s+/g, " ").trim();
    const date = (/\bDate:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(memoText) ?? [])[1] ?? null;
    return { ...r, memoText, date };
  });
  if (!all.length) return null; // none by either test: keep the existing honest "none on file" path
  const { date, terms } = memoFilters(question);
  const hits = all.filter((r) => (!date || r.date === date) && terms.every((t) => norm(r.memoText).includes(t)));
  const label = [terms.length ? `mentioning ${terms.join(" ")}` : null, date ? `dated ${date}` : null].filter(Boolean).join(" ");
  const sources = (r) => [{ documentId: r.id, location: {} }];
  if (!hits.length) {
    return attachCitations({ kind: "answer", text: `No internal memo ${label} is on file (${all.length} internal memo${all.length === 1 ? " is" : "s are"} on file in all).`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: all.slice(0, 8).map((r) => documentRecord(r, { label: `Internal memo · ${r.original_filename}`, sublabel: r.date ?? "" })), total: all.length, kind: "searched", basis: `Searched all ${all.length} internal memos${label ? ` for ${label}` : ""}; none match.` });
  }
  const one = (r) => `${r.date ?? "undated"}: ${r.memoText.replace(/^internal memo\s*/i, "").replace(/^Date:\s*\S+\s*/i, "").slice(0, 260)}`;
  const shown = hits.slice(0, 12);
  const text = hits.length === 1
    ? `There is 1 internal memo on file${label ? ` ${label}` : ""}. ${one(hits[0])}`
    : `There ${hits.length === 1 ? "is" : "are"} ${hits.length} internal memos on file${label ? ` ${label}` : ""}.${hits.length <= 3 ? " " + hits.map(one).join(" | ") : ""}`;
  return attachCitations({ kind: "answer", text, facts: shown.map((r) => ({ label: "Internal memo", value: one(r), sources: sources(r) })), sources: [], confidence: 1, verifiedCount: shown.length, unverifiedCount: 0, closest: [] },
    { records: shown.map((r) => documentRecord(r, { label: `Internal memo · ${r.original_filename}`, sublabel: r.date ?? "" })), total: hits.length, claimedCount: hits.length, basis: `Counted documents headed "INTERNAL MEMO" (or marked internal-audience), whether or not they name a customer${label ? `; filtered to ${label}` : ""}.` });
}
