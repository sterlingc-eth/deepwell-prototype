/**
 * Docread round (2026-10-22): the type a paper's OWN PAGE proves, applied everywhere a type is decided or re-judged.
 *
 * THE DEFECT (live): "COI - Palo 2025.pdf", "Plumbing License - Chloe Alvarez.pdf" ... stayed "Warranty registration — Needs:
 * serial number, model" after the inbox round shipped the License / certification and Insurance certificate fixes, because:
 *   1. those fixes ran at UPLOAD (resolveDocumentType) and in "Sort my documents" only; papers uploaded before the round keep
 *      their stored document_type until someone presses Sort (Re-check, the nightly sweep and "Verify with AI" never re-typed);
 *   2. the rule only trusted the FILE NAME (and a bare "COI" was deliberately not enough); the page itself, which says
 *      "CERTIFICATE OF LIABILITY INSURANCE" or "License No. JP-860244" under a licensing board, was never asked.
 * Now Re-check (single, bulk, nightly), "Read the page again", Sort and upload all call retypeDecision, which looks for
 * high-precision ANCHORS on the page first and then falls back to the existing file-name / title rule (resortDecision).
 * A type a person chose and a checked paper are never moved (callers pass humanChosen / verified).
 * Pure.
 */
import { resortDecision, canonicalTypeId, RESORT_SOURCE_TYPES } from "../documentTypes.js";
import { classifyFromText } from "./textExtract.js";

/** Types a page anchor may move a paper out of: the re-sort's sources plus the types licences / COIs get misfiled into. */
const ANCHOR_SOURCE_TYPES = new Set([...RESORT_SOURCE_TYPES, "inspection-report", "equipment-record", "permit", "nameplate-photo", "startup-sheet"]);

const firstLines = (pages, n = 45) => String((pages ?? []).find((p) => String(p?.text ?? "").trim())?.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n);
const SEG = /\s{2,}|\t|\s*\|\s*/;

const COI_TITLE = /^(?:acord\s*25\b.*|certificate\s+of\s+(?:liability\s+|property\s+|commercial\s+)?insurance|evidence\s+of\s+(?:commercial\s+)?(?:property|liability)\s+insurance|certificate\s+of\s+coverage)$/i;
const MONEY_TITLE = /^(?:(?:sales\s+|service\s+|progress\s+|tax\s+)?invoice|receipt|statement|bill|quote|estimate|proposal|bid(?:\s+proposal)?)(?:\s*#.*)?$/i;
const LICENSE_TITLE = /\b(?:licen[cs]e|licensure|certification|certificate\s+of\s+(?:competency|completion|registration|qualification)|credential|card)\b/i;
const LICENSE_NO = /^(?:licen[cs]e|lic\.?|certificate|cert\.?|certification|card|registration|credential)\s*(?:no\.?|number|#|num\.?)\s*:?$/i;
const ISSUER = /\b(?:board|department|commission|registrar|bureau|agency|division|authority|institute|environmental\s+protection|epa|licensing|state\s+of)\b/i;

/**
 * Page anchors. Returns {type, evidence} or null.
 *   insurance-certificate: a title line "CERTIFICATE OF LIABILITY INSURANCE" / "ACORD 25" / "EVIDENCE OF PROPERTY INSURANCE"
 *   license-certification: a title line naming a licence / certification / card AND a labelled licence number on its own segment
 *                          AND an issuing body (board, department, registrar ...) - never a contractor letterhead "Lic. #" line
 * Either is refused when the page's title says it is an invoice, receipt, statement or quote.
 */
export function anchorTypeFromText(pages) {
  const lines = firstLines(pages);
  if (!lines.length) return null;
  const segsOf = (l) => l.split(SEG).map((s) => s.trim()).filter(Boolean);
  const titles = lines.filter((l) => l.length <= 70).map((l) => l.replace(/[:.]+$/, "").trim());
  if (titles.some((t) => MONEY_TITLE.test(t))) return null;
  const coi = titles.find((t) => COI_TITLE.test(t));
  if (coi) return { type: "insurance-certificate", evidence: coi };
  // A permit, an inspection or a work order has a licence NUMBER line too ("License #  CO EC-218745" under a building division): the page's own title decides.
  if (titles.slice(0, 12).some((t) => /\b(?:permit|inspection|work\s+order|service\s+(?:ticket|call)|certificate\s+of\s+occupancy|proposal|estimate)\b/i.test(t) && !/\d/.test(t) && t.split(/\s+/).length <= 6)) return null;
  // a title is ONE short heading: a single cell, no digits, no label punctuation ("License #   CO EC-218745   Owner   ..." is a label row, not a title)
  const licTitle = titles.find((t) => LICENSE_TITLE.test(t) && t.split(/\s+/).length <= 8 && !SEG.test(t) && !/[#:]/.test(t) && !/\b(?:application|renewal\s+notice|invoice|fee)\b/i.test(t));
  if (licTitle) {
    const numLine = lines.find((l) => { const s = segsOf(l); return s.some((seg, i) => LICENSE_NO.test(seg) && /\d/.test(s[i + 1] ?? "")) || /^(?:licen[cs]e|certificate|card|certification)\s*(?:no\.?|number|#)\s*:\s*[A-Z0-9-]*\d/i.test(l); });
    const issuer = lines.slice(0, 12).find((l) => ISSUER.test(l));
    if (numLine && issuer) return { type: "license-certification", evidence: `${licTitle} / ${numLine.replace(/\s{2,}/g, " ")}` };
  }
  return null;
}

/**
 * The type a stored or new paper should have, or null to leave it. Same contract as resortDecision (never a person's choice,
 * never a checked paper), plus page anchors.
 * @returns {{to:string, from:string, source:'anchor'|'title'|'filename', evidence:string|null}|null}
 */
export function retypeDecision({ currentType, filename = null, pages = [], fields = [], humanChosen = false, verified = false, hrOverride = false }) {
  const cur = canonicalTypeId(currentType || "other");
  if (humanChosen || verified || hrOverride) return null;
  const keys = new Set((fields ?? []).filter((f) => String(f?.corrected_value ?? f?.value ?? "").trim()).map((f) => String(f.field_key ?? f.key)));
  const anchor = anchorTypeFromText(pages);
  if (anchor && anchor.type !== cur && ANCHOR_SOURCE_TYPES.has(cur)) {
    // A paper that says WARRANTY in its own title is a warranty card even when it mentions insurance.
    const saysWarranty = firstLines(pages, 12).some((l) => /\bwarrant(?:y|ies)\b/i.test(l) && l.length <= 70);
    // A money paper whose file name says invoice / receipt and that carries an amount stays a money paper.
    const moneyNamed = (cur === "invoice" || cur === "receipt") && keys.has("cost") && /invoice|receipt|\binv\b/i.test(String(filename ?? ""));
    if (!saysWarranty && !moneyNamed) return { to: anchor.type, from: cur, source: "anchor", evidence: anchor.evidence };
  }
  let hit = null;
  try { hit = classifyFromText(pages); } catch { hit = null; }
  const to = resortDecision({
    currentType: cur, filename, titleType: anchor?.type ?? hit?.type ?? null, titleText: anchor?.evidence ?? hit?.evidence ?? null,
    hasEquipmentFacts: keys.has("serial_number") || keys.has("model"),
  });
  if (!to) return null;
  const nameSays = !!filename && (anchor?.type ?? hit?.type) !== to;
  return { to, from: cur, source: nameSays ? "filename" : (anchor ? "anchor" : "title"), evidence: nameSays ? String(filename) : (anchor?.evidence ?? hit?.evidence ?? null) };
}
