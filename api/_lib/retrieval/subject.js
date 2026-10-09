/**
 * DONOVAN-R4 hard filter: the ONE subject a question names, resolved from stored rows only (no model). A document number beats a unit serial beats a customer's name.
 * Returns { kind: "document" | "unit" | "customer", label, documentIds } or null (nothing named, or what was named is not on file: the search then stays unfiltered, as today).
 * Names are matched as whole word sequences against this organization's customer names (never by capital letters, so "calloway & finch law" and "CALLOWAY FINCH LAW" are the
 * same); a bare first or last name is NOT a hard filter (it would hide other people's documents on a guess). Each organization sees only its own rows (store.* run inside withTenant).
 */
import * as store from "../records/store.js";
import { parseRecordsQuestion, tokensOf, normalizeText } from "../records/parse.js";
import { nameTokens } from "../lookups/nameMatch.js";
import { isNonNameWord } from "../lookups/commonWords.js";

const MAX_DOCS = 80;

export function matchNamedCustomers(question, customers) {
  const tokens = tokensOf(normalizeText(question));
  const qs = ` ${tokens.join(" ")} `;
  const hits = [];
  for (const c of customers) {
    const ct = nameTokens(c.name);
    if (!ct.length) continue;
    if (ct.length === 1) { if (ct[0].length >= 5 && !isNonNameWord(ct[0]) && tokens.includes(ct[0])) hits.push({ c, size: 1 }); continue; }
    if (qs.includes(` ${ct.join(" ")} `)) hits.push({ c, size: ct.length });
  }
  if (!hits.length) return [];
  // the longest name wins only over a name it CONTAINS ("Acme Holdings West" over "Acme Holdings"); two separate customers named in one question are both kept
  const joined = (h) => ` ${nameTokens(h.c.name).join(" ")} `;
  return hits.filter((h) => !hits.some((g) => g !== h && g.size > h.size && joined(g).includes(joined(h)))).map((h) => h.c);
}

export async function resolveSubject(db, question) {
  const p = parseRecordsQuestion(question, {});
  if (p.docNumbers?.length) {
    const docs = await store.docsByNumber(db, p.docNumbers);
    if (docs.length) {
      // a document number AND a customer named: the document must be that customer's, else the question mixes two subjects and nothing is filtered
      const named0 = matchNamedCustomers(question, await store.loadCustomers(db));
      if (named0.length && !docs.some((d) => named0.some((c) => c.id === d.customer_id))) return null;
    }
    if (docs.length) return { kind: "document", label: p.docNumbers.map((n) => n.raw).join(" "), documentIds: [...new Set(docs.map((d) => d.document_id))].slice(0, MAX_DOCS) };
  }
  if (p.serials?.length) {
    const units = await store.unitsBySerial(db, p.serials.filter((s) => !(p.docNumbers ?? []).some((d) => d.alnum === s)));
    const ids = [];
    for (const u of units.slice(0, 3)) for (const d of await store.docsForUnit(db, u.id)) ids.push(d.document_id);
    if (ids.length) return { kind: "unit", label: p.serials.join(" "), documentIds: [...new Set(ids)].slice(0, MAX_DOCS) };
  }
  const customers = await store.loadCustomers(db);
  const named = matchNamedCustomers(question, customers);
  if (!named.length) return null;
  const ids = [];
  for (const c of named.slice(0, 3)) for (const d of await store.docsForCustomer(db, c.id)) ids.push(d.document_id);
  if (!ids.length) return null;
  return { kind: "customer", label: named.map((c) => c.name).join(" and "), documentIds: [...new Set(ids)].slice(0, MAX_DOCS) };
}
