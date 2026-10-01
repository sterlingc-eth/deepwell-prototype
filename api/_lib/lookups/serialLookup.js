/**
 * R35 (owner decision 2026-10-01) — SERIAL LOOKUPS ARE DETERMINISTIC.
 *
 * Any question ABOUT a serial the user typed ("what unit is serial Y100007", "model for serial F100002", "who has serial ...",
 * "where's S/N ...", "sn 4N2119-08772", "serial 2c100003?") is answered from the live records: exact or normalized serial match
 * (case, dashes/spaces/dots ignored, letter O read as zero and letter I as one on BOTH sides) -> the unit (brand, model), customer,
 * address, install date, warranty status and last service, each cited. Nothing is hard-coded: every fact is read per request from
 * the tenant's equipment records and the documents tied to that unit, so a new upload is reflected on the next question.
 *
 *   - no unit has it: "No unit with serial X on file." + the closest serial when one is within one edit, or a note when X is a
 *     MODEL number on file. A serial printed only on a document (no unit record yet) is reported from that document.
 *   - two units share it (a data-entry collision): both are listed, never one picked.
 *   - a bare serial-shaped token with no "serial"/"s/n"/"sn" word is only claimed when it IS a serial on file (else null: the
 *     question goes on down the chain exactly as before).
 * The "what's the serial on X's unit" direction (no serial typed) is not this module's: fastPath / contactLookup keep it.
 * pure: parseSerialQuestion     db: runSerialLookup
 */
import { attachCitations, unitRecord, customerRecord } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, todayIso, humanDate, answerEnvelope, fetchVisits, splitFuture } from "../scope.js";
import { damerauLevenshteinDistance } from "../integrity.js";

const ANCHOR_RE = /\b(?:serial|seriel|serail|sereal|serial#)(?:\s*(?:number|num|nbr|no\.?|#))?|\bs\s*\/\s*n\b|\bs\.n\.?|\bsn\b|\bser\s*(?:no\.?|#)/gi;
// Words that may sit between the anchor and the serial ("serial number is X", "serial no: X").
const SKIP_AFTER_ANCHOR = new Set(["number", "num", "nbr", "no", "no.", "#", ":", "is", "was", "=", "of", "nr",
  // R35 partials: "serial ending in 100091", "serial that starts with Y1000", "serial containing 00045"
  "ending", "ends", "end", "that", "which", "starting", "starts", "start", "beginning", "begins", "containing", "contains", "with", "in", "like"]);
const CUSTOMER_NO_RE = /^c-?\d{3,6}$/i;
const INVOICE_LIKE_RE = /^(?:inv|po|wo|pm|p|q|est|tkt|job|bp)[-#]?\d/i;
const PHONE_RE = /^\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$/;

/** Canonical comparable form: alphanumerics only, upper case, letter O -> 0 and letter I -> 1 (both sides). */
export function canonSerial(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1");
}
/** The same canonical form in SQL (for an indexed-friendly equality on the stored value). */
const CANON_SQL = (expr) => `translate(upper(regexp_replace(${expr}, '[^A-Za-z0-9]', '', 'g')), 'OI', '01')`;

const isSerialShaped = (alnum) => alnum.length >= 5 && alnum.length <= 24 && /\d/.test(alnum);

/** Tokens right after an anchor word, joined while they still look like one serial ("Y 100103", "4N2119-08772"). */
function serialAfter(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && SKIP_AFTER_ANCHOR.has(toks[i].toLowerCase().replace(/[:#=]+$/, "") || toks[i])) i += 1;
  const parts = [];
  for (; i < toks.length && parts.length < 3; i += 1) {
    const raw = toks[i].replace(/^[#:("'“]+/, "").replace(/[?!,;)"'”]+$/, "").replace(/\.$/, "");
    const alnum = raw.replace(/[^A-Za-z0-9]/g, "");
    if (!alnum) break;
    if (/^[A-Za-z]+$/.test(alnum)) {
      // a short letter prefix split off ("Y 100103", "lx 100005") may continue; any real word ends the serial
      if (parts.length === 0 && alnum.length <= 3 && i + 1 < toks.length && /^\d/.test(toks[i + 1])) { parts.push(raw); continue; }
      break;
    }
    parts.push(raw);
    if (/[-]$/.test(toks[i]) === false && i + 1 < toks.length && !/^[-\d]/.test(toks[i + 1])) break;
  }
  const typed = parts.join(parts.length > 1 && /^[A-Za-z]{1,3}$/.test(parts[0]) ? " " : "");
  const alnum = typed.replace(/[^A-Za-z0-9]/g, "");
  if (!isSerialShaped(alnum)) return null;
  if (CUSTOMER_NO_RE.test(typed) || INVOICE_LIKE_RE.test(typed) || PHONE_RE.test(typed)) return null;
  return typed;
}

const FOCUS = [
  ["who", /\b(?:who|whose|whos|who's|customer|owner|owns|account|belong|belongs|client|homeowner|job is)\b/i],
  ["warranty", /\bwarrant\w*|\bcovered\b|\bcoverage\b/i],
  ["service", /\b(?:last|latest|recent|most recent)\s+(?:service|serviced|visit|visited|call|time|tech|worked)\b|\blast\s+serviced\b|\bserviced\b|\bworked on\b/i],
  ["where", /\bwhere\b|\baddress\b|\blocation\b|\blocated\b/i],
  ["install", /\binstall(?:ed|ation|ed on)?\b|\bput in\b|\bhow old\b|\bage\b/i],
  ["brand", /\b(?:brand|make|manufacturer|mfr)\b/i],
  ["model", /\bmodel\b/i],
];

/** Typed in quotes ("exactly as typed", the escape the "Not what you meant?" chip uses): never widened to a partial match. */
function isQuoted(q, typed) {
  const at = q.indexOf(typed);
  return at > 0 && /["“”']/.test(q[at - 1]);
}

function focusOf(q) {
  for (const [name, re] of FOCUS) if (re.test(q)) return name;
  return "unit";
}

/**
 * Pure. @returns {serial: string, anchored: boolean, focus: string, question} or null.
 */
export function parseSerialQuestion(question) {
  const q = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!q || q.length > 220) return null;
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(q))) {
    const rest = q.slice(m.index + m[0].length);
    // "serial for model X" / "serial on the unit at ..." asks FOR a serial: never treat what follows as one
    if (/^\s*(?:for|on|at|of\s+the|of\s+their|of\s+his|of\s+her|in)\b/i.test(rest)) continue;
    const typed = serialAfter(rest.replace(/^[\s:#=]+/, " "));
    if (typed) return { serial: typed, anchored: true, quoted: isQuoted(q, typed), focus: focusOf(q.slice(0, m.index) + " " + q.slice(m.index + m[0].length).replace(typed, " ")), question: q };
  }
  // bare token: short question, one letters+digits token (claimed only when it IS a serial on file — decided at run time)
  const words = q.split(/\s+/);
  if (words.length > 10) return null;
  const cands = words.map((w) => w.replace(/^[#:("'“]+/, "").replace(/[?!,.;)"'”]+$/, "")).filter((w) => {
    const a = w.replace(/[^A-Za-z0-9]/g, "");
    return isSerialShaped(a) && a.length >= 6 && /[A-Za-z]/.test(a) && /^[A-Za-z0-9-]+$/.test(w) && !CUSTOMER_NO_RE.test(w) && !INVOICE_LIKE_RE.test(w) && !/^r-?\d{2,4}[a-z]?$/i.test(w);
  });
  if (cands.length !== 1) return null;
  // a bare token next to "model"/"part"/"invoice"/... names something else
  if (/\b(?:model|part|invoice|inv|po|permit|order|ticket|job|quote|estimate|customer|account)\s*(?:number|no\.?|#)?\s*:?\s*$/i.test(q.slice(0, q.indexOf(cands[0])))) return null;
  return { serial: cands[0], anchored: false, quoted: isQuoted(q, cands[0]), focus: focusOf(q.replace(cands[0], " ")), question: q };
}

/* ------------------------------------------------------------------ run */

const brandModel = (u) => [u.manufacturer, u.model].filter(Boolean).join(" ") || "unit";
const shortAddr = (a) => String(a ?? "").trim();

function warrantyOf(u, today) {
  const exp = /^\d{4}-\d{2}-\d{2}/.test(String(u.expires ?? "")) ? String(u.expires).slice(0, 10) : null;
  if (!exp) return { status: "unknown", text: "no warranty end date on file", exp: null };
  if (exp < today) return { status: "expired", text: `warranty expired ${humanDate(exp)}`, exp };
  const days = (Date.parse(exp) - Date.parse(today)) / 86400000;
  if (days <= 365) return { status: "expiring", text: `under warranty until ${humanDate(exp)} (expiring within 12 months)`, exp };
  return { status: "active", text: `under warranty until ${humanDate(exp)}`, exp };
}

async function unitsBySerial(db, typed) {
  const { rows } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->>'serial_number' AS serial_number, e.data->>'manufacturer' AS manufacturer, e.data->>'model' AS model,
            e.data->>'equipment_type' AS equipment_type, e.data->>'tonnage' AS tonnage, e.data->>'installation_date' AS installation_date,
            e.data#>>'{warranty,expires}' AS expires, COALESCE(NULLIF(e.data->>'service_address', ''), c.data->>'service_address') AS address,
            c.data->>'customer_name' AS customer_name
       FROM entities e
       LEFT JOIN entities c ON c.id = e.customer_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
        AND ${CANON_SQL("e.data->>'serial_number'")} = $1
      LIMIT 6`,
    [canonSerial(typed)]
  );
  return rows;
}

async function unitDocumentIds(db, unitId) {
  const { rows } = await db.raw(
    `SELECT DISTINCT document_id FROM (
       SELECT document_id FROM extractions WHERE entity_id = $1 AND ${TENANT_SQL}
       UNION SELECT document_id FROM document_entity_links WHERE entity_id = $1 AND ${TENANT_SQL}) s LIMIT 500`,
    [unitId]
  );
  return rows.map((r) => r.document_id);
}

async function documentsBySerial(db, typed) {
  const { rows } = await db.raw(
    `SELECT x.document_id, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS serial_number,
            (SELECT COALESCE(NULLIF(m.corrected_value, ''), m.value) FROM extractions m WHERE m.document_id = x.document_id AND m.field_key = 'model' AND m.${TENANT_SQL} LIMIT 1) AS model,
            (SELECT COALESCE(NULLIF(b.corrected_value, ''), b.value) FROM extractions b WHERE b.document_id = x.document_id AND b.field_key = 'manufacturer' AND b.${TENANT_SQL} LIMIT 1) AS manufacturer
       FROM extractions x
      WHERE x.field_key = 'serial_number' AND x.${TENANT_SQL} AND ${CANON_SQL("COALESCE(NULLIF(x.corrected_value, ''), x.value)")} = $1
      LIMIT 5`,
    [canonSerial(typed)]
  );
  return rows;
}

async function nearestSerials(db, typed) {
  const want = canonSerial(typed);
  const { rows } = await db.raw(
    `SELECT DISTINCT data->>'serial_number' AS s FROM entities
      WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'serial_number' IS NOT NULL
        AND length(data->>'serial_number') BETWEEN $1 AND $2
      LIMIT 20000`,
    [Math.max(1, want.length - 2), want.length + 4]
  );
  return rows.map((r) => r.s).filter((s) => { const c = canonSerial(s); return Math.abs(c.length - want.length) <= 1 && damerauLevenshteinDistance(c, want) === 1; }).slice(0, 3);
}

/** R35: units whose canonical serial CONTAINS the typed fragment (>= 5 characters, at least one digit). At most 6 rows. */
async function unitsByPartialSerial(db, typed) {
  const frag = canonSerial(typed);
  if (frag.length < 5 || !/\d/.test(frag)) return [];
  const { rows } = await db.raw(
    `SELECT e.data->>'serial_number' AS serial_number, c.data->>'customer_name' AS customer_name
       FROM entities e
       LEFT JOIN entities c ON c.id = e.customer_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL} AND e.data->>'serial_number' IS NOT NULL
        AND strpos(${CANON_SQL("e.data->>'serial_number'")}, $1) > 0
      LIMIT 6`,
    [frag]
  );
  // two units with the same serial are one serial here (the collision answer lists both units)
  const seen = new Map();
  for (const r of rows) if (!seen.has(canonSerial(r.serial_number))) seen.set(canonSerial(r.serial_number), r);
  return [...seen.values()];
}

async function modelMatchCount(db, typed) {
  const { rows } = await db.raw(
    `SELECT count(*)::int AS n FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}
        AND ${CANON_SQL("data->>'model'")} = $1`,
    [canonSerial(typed)]
  );
  return Number(rows[0]?.n ?? 0);
}

function noUnitAnswer(typed, { near = [], modelCount = 0 } = {}) {
  const shown = typed.toUpperCase();
  const extra = modelCount
    ? ` ${shown} is a model number on file (${modelCount} unit${modelCount === 1 ? "" : "s"}), not a serial.`
    : near.length ? ` Closest serial on file: ${near.join(", ")}.` : "";
  return attachCitations(
    { kind: "no-answer", text: `No unit with serial ${shown} on file.${extra}`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
    { records: [], total: 0, kind: "searched", basis: `Searched every unit's serial number (ignoring case, dashes and spaces, and reading O as 0 and I as 1) for ${shown}; none matches.` }
  );
}

/**
 * @returns an /api/ask data object, or null (a bare token that is not a serial on file: carry on down the chain).
 */
export async function runSerialLookup(db, intent, { today } = {}) {
  const t = todayIso(today);
  const typed = intent.serial;
  const units = await unitsBySerial(db, typed);
  if (!units.length) {
    const docs = await documentsBySerial(db, typed);
    if (docs.length) {
      const d = docs[0];
      const what = [d.manufacturer, d.model].filter(Boolean).join(" ");
      const text = `Serial ${d.serial_number} appears on ${docs.length === 1 ? "a document" : `${docs.length} documents`}${what ? ` (${what})` : ""}, but no unit record is set up for it yet.`;
      return attachCitations(answerEnvelope({ text, facts: [{ label: "Serial", value: d.serial_number, sources: docs.map((x) => ({ documentId: x.document_id, location: { field: "serial_number" } })) }] }),
        { records: await documentRecordsFor(db, docs.map((x) => x.document_id)), total: docs.length, basis: `Matched serial ${d.serial_number} on the document${docs.length === 1 ? "" : "s"} listed; no unit record carries it.` });
    }
    if (!intent.anchored) return null;
    // R35 (owner decision 2026-10-01): a PARTIAL serial (>= 5 characters, not typed in quotes) answers when exactly ONE unit's serial
    // contains it; several -> they are listed and none is picked.
    const partial = intent.quoted ? [] : await unitsByPartialSerial(db, typed);
    if (partial.length === 1) {
      const ans = await runSerialLookup(db, { ...intent, serial: partial[0].serial_number, quoted: true, partialOf: typed }, { today });
      if (ans?.kind === "answer") {
        ans.text = `Showing results for serial ${partial[0].serial_number} (you typed "${typed}"). ${ans.text}`;
        return ans;
      }
    }
    if (partial.length > 1) {
      const shown = typed.toUpperCase();
      const list = partial.slice(0, 5).map((u) => `${u.serial_number}${u.customer_name ? ` (${u.customer_name})` : ""}`).join(", ");
      return attachCitations(
        { kind: "no-answer", text: `More than one serial on file contains ${shown}: ${list}${partial.length > 5 ? ", and more" : ""}. Which one?`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
        { records: [], total: 0, kind: "searched", basis: `Searched every unit's serial number for ones containing ${shown}; ${partial.length > 5 ? "more than 5" : partial.length} match, so none is picked.` }
      );
    }
    const modelCount = await modelMatchCount(db, typed);
    return noUnitAnswer(typed, { modelCount, near: modelCount ? [] : await nearestSerials(db, typed) });
  }
  if (units.length > 1) {
    const list = units.map((u) => `${brandModel(u)}${u.customer_name ? ` (${u.customer_name}` : " ("}${u.address ? `${u.customer_name ? ", " : ""}${shortAddr(u.address)}` : ""})`).join("; ");
    const text = `${units.length} units on file share serial ${units[0].serial_number}: ${list}. Check which one you mean.`;
    return attachCitations(answerEnvelope({ text, facts: units.map((u, i) => ({ label: `Unit ${i + 1}`, value: `${brandModel(u)}${u.customer_name ? ` · ${u.customer_name}` : ""}`, sources: [] })) }),
      { records: units.map((u) => unitRecord(u)), total: units.length, basis: `Matched serial ${units[0].serial_number} against every unit; ${units.length} units carry it.` });
  }
  const u = units[0];
  const serial = u.serial_number;
  const w = warrantyOf(u, t);
  const docIds = await unitDocumentIds(db, u.id);
  const { past } = splitFuture(await fetchVisits(db, docIds), t);
  past.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const last = past[0] ?? null;
  const who = u.customer_name || null;
  const at = u.address ? shortAddr(u.address) : null;
  const ident = `${brandModel(u)}${who ? `, ${who}` : ""}`;
  const installed = /^\d{4}-\d{2}-\d{2}/.test(String(u.installation_date ?? "")) ? humanDate(String(u.installation_date).slice(0, 10)) : (u.installation_date || null);
  const lastText = last ? `last serviced ${humanDate(last.date)}${last.technician ? ` (${last.technician})` : ""}` : "no service visit on file";

  let text;
  switch (intent.focus) {
    case "who": text = who ? `Serial ${serial} belongs to ${who} — ${brandModel(u)}${at ? ` at ${at}` : ""}.` : `Serial ${serial} is a ${brandModel(u)}; no customer is linked to it.`; break;
    case "model": text = `Serial ${serial} is a ${brandModel(u)}${u.tonnage ? ` (${u.tonnage})` : ""}${who ? ` — ${who}` : ""}.`; break;
    case "brand": text = `Serial ${serial} is a ${u.manufacturer || "unit of unknown brand"}${u.model ? ` (model ${u.model})` : ""}${who ? ` — ${who}` : ""}.`; break;
    case "where": text = at ? `Serial ${serial} is at ${at}${who ? ` (${who})` : ""}.` : `No address is on file for serial ${serial} (${ident}).`; break;
    case "install": text = installed ? `Serial ${serial} (${ident}) was installed ${installed}.` : `No install date is on file for serial ${serial} (${ident}).`; break;
    case "warranty":
      text = w.status === "unknown" ? `Serial ${serial} (${ident}): no warranty end date on file.`
        : w.status === "expired" ? `No — serial ${serial} (${ident}): ${w.text}.`
          : `Yes — serial ${serial} (${ident}) is ${w.text}.`;
      break;
    case "service": text = last ? `Serial ${serial} (${ident}) was ${lastText}.` : `No service visit is on file for serial ${serial} (${ident}).`; break;
    default:
      text = `Serial ${serial}: ${brandModel(u)}${u.tonnage ? ` (${u.tonnage})` : ""}${who ? `, ${who}` : ""}${at ? `, ${at}` : ""}. ` +
        `${installed ? `Installed ${installed}; ` : ""}${w.text}; ${lastText}.`;
  }
  const facts = [
    { label: "Serial", value: serial, sources: [] },
    { label: "Unit", value: brandModel(u), sources: [] },
    ...(who ? [{ label: "Customer", value: who, sources: [] }] : []),
    ...(at ? [{ label: "Address", value: at, sources: [] }] : []),
    ...(installed ? [{ label: "Installed", value: installed, sources: [] }] : []),
    { label: "Warranty", value: w.status === "unknown" ? "no end date on file" : w.status === "expired" ? `expired ${humanDate(w.exp)}` : `until ${humanDate(w.exp)}`, sources: [] },
    ...(last ? [{ label: "Last service", value: humanDate(last.date), sources: [{ documentId: last.documentId, location: { field: "service_date" } }] }] : []),
  ];
  const lastDoc = last ? await documentRecordsFor(db, [last.documentId]) : [];
  const records = [unitRecord(u), ...(u.customer_id && who ? [customerRecord({ id: u.customer_id, customer_name: who })] : []), ...lastDoc];
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "serial_lookup" } }), {
    records, total: records.length,
    basis: `Matched serial ${serial} to one unit record${intent.serial.toUpperCase() !== serial.toUpperCase() ? ` (typed "${intent.serial}")` : ""}; read its own brand, model, customer, address, install date and warranty end date${last ? ", and the latest dated visit on a document tied to that unit" : ""}.`,
  });
}
