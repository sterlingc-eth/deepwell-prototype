/**
 * R41N E3 - vendor bills ("payable" invoices): "total billed by Fresh Start Cleaning", "the most Clearview Glass ever charged us on
 * one invoice", "how much have we paid AllStar Locksmith for cleaning".
 * The vendor is resolved against THIS tenant's own payable rows (document_financials.vendor_name): the whole stored name must appear in
 * the question. Total = sum of that vendor's bill totals (corrections win, like every financials answer); biggest/smallest = the one
 * bill, cited. A work-type qualifier ("for cleaning") on a known vendor cannot be split from the totals -> null (falls through).
 * A capitalised name that is neither a vendor nor a customer, in a tenant that does track vendor bills -> honest "no bills from X".
 * Anything unclear returns null. Kill switch: DONOVAN_VENDOR_BILLS=0.
 * pure: parseVendorBills     db: runVendorBills
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { answerEnvelope, humanDate } from "../scope.js";
import { buildViewsSql } from "../agent/tools.js";
import { extractionsHaveUnitIndex } from "../recordsStore.js";

const DATEISH = /\b(?:19|20)\d\d\b|\b(?:last|this|past|since|between|before|after|ago|month|quarter|week|ytd|year|today|yesterday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const MONEY_VERB = /\b(?:billed|paid|pay|spent|spend|charged|invoiced)\b/i;
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
const OK_WORDS = new Set("s a an the what whats what's is was are were did do does have has had we us our you me my ever with total totals how much most least biggest largest highest smallest lowest cheapest max maximum min minimum billed bill bills paid pay spent spend charged charge charges invoiced invoice invoices one single by from to of in on for all time overall so far lol please thanks thx pls um ok okay hey yo quick real sorry more alright hang one ivnoice bliled biled".split(" "));
const fmt = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pure. @returns {kind:"vendor-bills", op:"total"|"max"|"min", question, qualifier, unknownName} or null. */
export function parseVendorBills(question) {
  if (process.env.DONOVAN_VENDOR_BILLS === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 160) return null;
  const q = raw.toLowerCase().replace(/[?!.]+$/, "");
  if (/\bhow many\b|\bnumber of\b|\bcount\b|\bover\b|\bunder\b|\bunpaid\b|\bopen\b|\boverdue\b|\bowe[ds]?\b|\boutstanding\b|\bpayable\b|\bbalance\b|\bdue\b/.test(q) || DATEISH.test(q)) return null;
  let op = null;
  if (/\b(?:most|biggest|largest|highest|max(?:imum)?)\b/.test(q) && /\b(?:charged|billed|from|by)\b/.test(q) && /\b(?:invoice|bill)\b/.test(q)) op = "max";
  else if (/\b(?:least|smallest|lowest|min(?:imum)?|cheapest)\b/.test(q) && /\b(?:charged|billed|from|by)\b/.test(q) && /\b(?:invoice|bill)\b/.test(q)) op = "min";
  else if (/\b(?:total|how much)\b/.test(q) && MONEY_VERB.test(q)) op = "total";
  if (!op) return null;
  const qm = /\bfor\s+(?!us\b|me\b)([a-z][a-z' -]{2,40})$/i.exec(raw.replace(/[?!.]+$/, ""));
  const um = op === "total" ? /\bpaid\s+((?:[A-Z][\w&'-]*\s+){1,3}[A-Z][\w&'-]*)(?=\s+for\b|\s*$)/.exec(raw.replace(/[?!.]+$/, "")) : null;
  return { kind: "vendor-bills", op, question: raw, qualifier: qm ? qm[1].trim() : null, unknownName: um ? um[1].trim() : null };
}

// one-edit typo tolerance per word of 5+ letters (a dropped, doubled, swapped or wrong letter), words in order and adjacent
function near(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}
function containsName(paddedQ, name) {
  if (paddedQ.includes(` ${name} `)) return true;
  const qw = paddedQ.trim().split(" "); const nw = name.split(" ");
  for (let i = 0; i + nw.length <= qw.length; i++) if (nw.every((w, j) => near(qw[i + j], w))) return true;
  return false;
}

async function financialRows(db, sql, params = []) {
  const views = buildViewsSql({ hasUnitIndex: await extractionsHaveUnitIndex(db), hasFinancials: true });
  return (await db.raw(`WITH ${views} ${sql}`, [JSON.stringify({ c: [], e: [] }), ...params])).rows;
}

/** @returns an /api/ask data object, or null. */
export async function runVendorBills(db, intent) {
  let vendors;
  try {
    vendors = await financialRows(db, `SELECT f.vendor_name, count(*)::int AS n FROM financials f WHERE f.direction = 'payable' AND f.doc_kind IN ('invoice','po') AND f.vendor_name IS NOT NULL GROUP BY 1`);
  } catch { return null; }
  if (!vendors.length) return null;
  const nq = ` ${norm(intent.question)} `;
  const hits = vendors.filter((v) => norm(v.vendor_name).length >= 4 && containsName(nq, norm(v.vendor_name)));
  if (hits.length > 1) return null;
  if (!hits.length) {
    if (!intent.unknownName) return null;
    const unw = norm(intent.unknownName).split(" ").filter((w) => w.length >= 3);
    // never for a name any vendor / customer / maker / this organization's own name resembles: those belong to other lanes
    const known = [];
    for (const v of vendors) known.push(...norm(v.vendor_name).split(" "));
    const probes = [
      [`SELECT lower(e.data->>'customer_name') AS n FROM entities e WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid`],
      [`SELECT DISTINCT lower(e.data->>'manufacturer') AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid`],
      [`SELECT lower(name) AS n FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid`],
      [`SELECT DISTINCT lower(x.value) AS n FROM extractions x WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid AND x.field_key IN ('vendor','technician','manufacturer','company','company_name')`],
    ];
    for (const [sql] of probes) {
      let rows = []; try { rows = (await db.raw(sql)).rows; } catch { /* optional table / column */ }
      for (const r of rows) known.push(...norm(r.n).split(" "));
    }
    if (unw.some((w) => known.some((k) => k.length >= 3 && (k === w || near(k, w))))) return null;
    // no payment claim: only that nothing is on file under that name
    return attachCitations(
      answerEnvelope({ text: `No bills from ${intent.unknownName} are on file.`, facts: [] }),
      { records: [], total: 0, kind: "searched", basis: `Searched the vendor names on every bill on file; none is ${intent.unknownName}.` }
    );
  }
  if (intent.qualifier) return null;
  // any other condition the totals cannot apply (a unit, address, customer, negation, place, a second name) -> step aside
  {
    let rest = ` ${nq} `.replace(` ${norm(hits[0].vendor_name)} `, " ");
    for (const w of norm(hits[0].vendor_name).split(" ")) rest = rest.replace(new RegExp(` ${w} `, "g"), " ");
    rest = rest.replace(/\b(?:on|in|for) (?:one|a single|any single|a) (?:invoice|bill)\b/g, " ").replace(/\bfor (?:us|me)\b/g, " ");
    const left = rest.split(" ").filter(Boolean).filter((w) => !OK_WORDS.has(w));
    if (left.length) return null;
  }
  const vendor = hits[0].vendor_name;
  const rows = await financialRows(db, `SELECT f.document_id, f.invoice_number, f.doc_date::text AS doc_date, f.total, f.status, f.amount_paid, f.doc_kind FROM financials f WHERE f.direction = 'payable' AND f.doc_kind IN ('invoice','po') AND f.vendor_name = $2 AND f.total IS NOT NULL ORDER BY f.total ${intent.op === "min" ? "ASC" : "DESC"}, f.doc_date DESC NULLS LAST, f.document_id`, [vendor]);
  if (!rows.length) return null;
  const kinds = new Set(rows.map((r) => r.doc_kind));
  const noun = (n) => (kinds.size === 1 && kinds.has('po') ? `purchase order${n === 1 ? '' : 's'}` : kinds.size === 1 ? `bill${n === 1 ? '' : 's'}` : `bill${n === 1 ? '' : 's'} and purchase order${n === 1 ? '' : 's'}`);
  let text; let ids; let basis;
  if (intent.op === "total") {
    const sum = rows.reduce((a, r) => a + Math.round(Number(r.total) * 100), 0) / 100;
    const askedPaid = /\b(?:paid|pay|spent|spend)\b/i.test(intent.question);
    const known = rows.every((r) => ["paid", "unpaid", "partial"].includes(String(r.status ?? "").toLowerCase()));
    const paidC = rows.reduce((a, r) => a + (String(r.status).toLowerCase() === "paid" ? Math.round(Number(r.amount_paid ?? r.total) * 100) : String(r.status).toLowerCase() === "partial" ? Math.round(Number(r.amount_paid ?? 0) * 100) : 0), 0);
    if (askedPaid && known) text = `Of the ${fmt(sum)} ${vendor} has billed us across ${rows.length} ${noun(rows.length)}, ${fmt(paidC / 100)} is recorded as paid and ${fmt(sum - paidC / 100)} is still unpaid.`;
    else if (askedPaid) text = `Payment status is not recorded on every bill from ${vendor}, so I can't say what was paid. What I can say: ${vendor} has billed us ${fmt(sum)} in total across ${rows.length} ${noun(rows.length)}.`;
    else if (kinds.size === 1 && kinds.has('po')) text = `Purchase orders to ${vendor} total ${fmt(sum)} across ${rows.length} ${noun(rows.length)} (ordered amounts; payment status is not recorded).`;
    else text = `${vendor} has billed us ${fmt(sum)} in total across ${rows.length} ${noun(rows.length)}.`;
    ids = rows.map((r) => r.document_id).slice(0, 25);
    basis = `Added up the totals of the ${rows.length} documents from ${vendor} (billed amounts; payment status read from each bill where recorded).`;
  } else {
    const top = rows[0]; const ties = rows.filter((r) => Number(r.total) === Number(top.total));
    const d = top.doc_date ? humanDate(top.doc_date.slice(0, 10)) : null;
    text = `The ${intent.op === "min" ? "least" : "most"} ${vendor} has charged us on one invoice is ${fmt(top.total)}${top.invoice_number ? ` (#${top.invoice_number}${d ? `, dated ${d}` : ""})` : d ? ` (dated ${d})` : ""}${ties.length > 1 ? `; ${ties.length - 1} other bill${ties.length === 2 ? "" : "s"} from them have the same amount` : ""}.`;
    ids = ties.map((r) => r.document_id).slice(0, 10);
    basis = `Compared the totals of the ${rows.length} documents from ${vendor}.`;
  }
  const records = await documentRecordsFor(db, ids);
  const src = ids.map((documentId) => ({ documentId, location: { field: "total" } }));
  return attachCitations(answerEnvelope({ text, facts: [{ label: "Vendor", value: vendor, sources: src.slice(0, 1) }, { label: intent.op === "total" ? "Total billed" : "Amount", value: text.match(/\$[\d,]+\.\d\d/)?.[0] ?? "", sources: src }], sources: src, extra: { fastIntent: "vendor_bills" } }), { records, total: records.length, basis });
}
