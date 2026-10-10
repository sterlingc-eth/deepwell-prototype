/**
 * R45 (Builder 2) - the GENERAL scope rule behind the honest "not in your records" decline (replaces closed phrase lists).
 *
 * A question is OUT OF SCOPE, and is declined at $0 with no model, when ALL of these hold:
 *   1. it has at least one content word (a word that is not a function/question/filler word);
 *   2. NONE of its content words is tenant vocabulary: not a records/HVAC/finance/document-type/field word, not a brand, and not a
 *      word that appears in this tenant's own data (customer, address, vendor, technician, equipment, document filename, extracted
 *      value) - checked by `wordInOrgData` below, and not a one-or-two-letter typo of either of those;
 *   3. it is not a general help / how-to question about DeepWell itself, and carries no digit, '@' or '#' (an id, address, amount, date).
 *
 *   contentTokens(question)           pure: the content words
 *   isHelpQuestion(question)          pure: "how do I upload", "what does DeepWell cost", ...
 *   staticAnchor(token)               pure: is the token records/business vocabulary (or a typo of it)?
 *   wordInOrgData(db, words)          db: the subset of `words` present anywhere in this tenant's entities / extracted values / filenames
 *   buildNoAnchorDecline(db, question)  db: the honest decline answer, or null (anything is unsure)
 *
 * Why it is safe: a false decline needs a real records question that shares NO word with the lexicon, with the tenant's data, and is not
 * within two edits of either. Anything else - including a lower-case customer name, a vendor, a typo - finds an anchor and goes on down the
 * normal chain unchanged. Kill switch: DONOVAN_NO_ANCHOR_DECLINE=0.
 *
 * Wording: reuses the app's existing out-of-domain sentence (contactLookup.js buildOutOfDomainAnswer).
 */
import { TENANT_SQL } from "../scope.js";
import { VOCAB } from "../nlNormalize.js";
import { RECORDS_WORDS } from "../modelAvoidance/nonQuestion.js";
import { RECORD_ANCHOR_RE } from "../router/earlyDecline.js";
import { DOCTYPE_TRIGGER_WORDS, FIELD_LABELS } from "../documentTypes.js";
import { BRAND_WORDS } from "../analytics.js";
import { damerauLevenshteinDistance } from "../integrity.js";
import { stripConversationalFrame } from "../router/frame.js";
import { buildOutOfDomainAnswer } from "../contactLookup.js";

export const noAnchorEnabled = () => process.env.DONOVAN_NO_ANCHOR_DECLINE !== "0";

const W = (s) => s.split(/\s+/).filter(Boolean);

/** Function words, question words, request verbs and filler: never evidence for or against being a records question. */
const STOP = new Set(W(`
a an the and or but if of in on at to for from by with without about as into onto over under between among through during before after above below up down out off again then once here there when where why how
all any both each few more most other some such no nor not only own same so than too very can will just should now i me my myself we our ours ourselves you your yours yourself he him his she her it its they them their what which who whom this that these those
am is are was were be been being have has had having do does did doing would could may might must shall please pls tell show give get got gimme find list pull want need needs like know see look let lets also still ever really actually
anything everything something nothing yes yeah yep no nope ok okay sure thanks thank hi hello hey much many one two three four five six seven eight nine ten first last next another us ones whats whos hows thats im ive id ill dont doesnt didnt cant wont isnt arent wasnt
tell say said think thought make made take took go going gone come came try use used using able let kind sort type thing things stuff way bit lot lots little big small good bad best better new old right wrong real
`));

/** Business-generic and records-adjacent words that make a question about THIS business (broad on purpose: a miss only costs a defer). */
const EXTRA_ANCHORS = new Set(W(`
business company companies shop firm operation operations overview snapshot summary health books bookkeeping finances financial finance accounting sales money income profit profits margin margins cash expense expenses spend spending spent
paid pay pays payment payments owe owes owed collect collected collection collections receivable receivables payable payables risk risks unusual weird anomaly anomalies duplicate duplicates missing flagged attention priority priorities follow followup followups
staff employee employees team crew owner manager dispatcher office vendor vendors supplier suppliers client clients patient tenant tenants property properties site sites building buildings location locations lease leases
quote quotes estimate estimates proposal proposals receipt receipts statement statements agreement agreements contract contracts certificate certificates inspection inspections report reports log logs sheet sheets form forms
plumbing electrical electric roof roofing pipe pipes drain water leak leaks panel panels breaker breakers wire wiring generator generators boiler heater heaters duct ducts vent vents fan fans blower capacitor capacitors contactor contactors
tuneup tuneups tune callback callbacks emergency emergencies startup startups commissioning dispatch dispatched callout callouts truck trucks van vans vehicle vehicles tool tools inventory stock labor hours hour rate rates markup discount discounts tax taxes
hvac cooling heating refrigeration refrigerant freon furnace furnaces thermostat thermostats condenser condensers evaporator coil coils compressor compressors handler handlers rtu rtus minisplit minisplits
warranty warranties expire expires expired expiring renewal renewals renew renewed lapse lapsed due overdue late unpaid open closed pending status approved declined cancelled canceled
doc docs pdf pdfs scan scans scanned upload uploads uploaded page pages file files filed attachment attachments paperwork
customer customers account accounts address addresses city cities county state zip street phone email contact name names number numbers serial serials model models brand brands manufacturer make tonnage seer age ages install installed installs installation replaced replacement repaired repair repairs
service services serviced visit visits job jobs ticket tickets call calls appointment appointments schedule scheduled invoice invoices bill bills billed billing balance revenue price prices pricing cost costs charge charged charges total totals amount amounts average percent percentage count counts
donovan deepwell technician technicians tech techs
letter letters correspondence mail memo memos note notes message messages text texts reminder reminders notice notices
cust custs cstmr cstmrs equip eqpt inv invs est ests wo wos po pos pm pms svc svcs srvc maint hvacr ac acs ahu rtu rtus furn cond comp thermo stat
`));

const FIELD_WORDS = new Set(Object.values(FIELD_LABELS).flatMap((l) => String(l).toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3)));
const STATIC = new Set([
  ...VOCAB, ...RECORDS_WORDS, ...EXTRA_ANCHORS, ...DOCTYPE_TRIGGER_WORDS.map((w) => w.toLowerCase()), ...FIELD_WORDS, ...BRAND_WORDS.flatMap((b) => b.split(" ")),
]);
const STATIC_LONG = [...STATIC].filter((w) => w.length >= 5);

const singular = (t) => (t.endsWith("ies") && t.length > 4 ? t.slice(0, -3) + "y" : t.endsWith("es") && t.length > 4 ? t.slice(0, -2) : t.endsWith("s") && t.length > 3 ? t.slice(0, -1) : t);

/** Content words of a question: lower-case letters only, possessive stripped, function words removed. */
export function contentTokens(question) {
  const q = String(question ?? "").toLowerCase().normalize("NFKC").replace(/[’`]/g, "'");
  const out = [];
  for (const raw of q.split(/[^a-z']+/)) {
    const t = raw.replace(/'s$/, "").replace(/^'+|'+$/g, "").replace(/'/g, "");
    if (t.length < 2 || STOP.has(t) || STOP.has(singular(t))) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

const HELP_RE = new RegExp(
  String.raw`\bhow\s+(?:do|can|could|would|should|does|to|did)\b|\bwhere\s+(?:do|can|is|are)\s+(?:i|we|the)\b|\bwhere\s+(?:to|can\s+i)\b|\b(?:can|could|may)\s+(?:i|we|you)\b|\bwhat\s+(?:can|does|do|is|are)\s+(?:you|donovan|deepwell|this|the\s+(?:app|tool|system|platform|assistant))\b|` +
    String.raw`\b(?:deepwell|donovan)\b|\b(?:log\s*in|login|sign\s*(?:in|up|out)|password|reset|subscription|upgrade|downgrade|pricing|plans?|billing\s+(?:page|settings|portal)|invite|seats?|permissions?|roles?|settings|export|import|integrations?|api\s+keys?|support|help|tutorial|guide|feature|features|bug|error|not\s+working)\b`,
  "i"
);
/** A general help / how-to question about the app itself (never declined here; the support / help lanes own it). */
export function isHelpQuestion(question) {
  return HELP_RE.test(String(question ?? ""));
}

/** Is the token records/business vocabulary, or within an edit (two for long words) of it? Pure. */
export function staticAnchor(token) {
  const t = String(token ?? "");
  if (!t) return false;
  if (STATIC.has(t) || STATIC.has(singular(t))) return true;
  if (RECORD_ANCHOR_RE.test(t)) return true;
  if (t.length === 4) { for (const w of STATIC) if (w.length >= 4 && w.length <= 5 && w[0] === t[0] && Math.abs(w.length - 4) <= 1 && damerauLevenshteinDistance(t, w) <= 1) return true; }
  if (t.length >= 5) {
    const max = t.length >= 8 ? 2 : 1;
    for (const w of STATIC_LONG) if (Math.abs(w.length - t.length) <= max && damerauLevenshteinDistance(t, w) <= max) return true;
  }
  return false;
}

/** The subset of `words` that occurs (as a whole word) anywhere in this tenant's entities, extracted values or document filenames. */
export async function wordInOrgData(db, words) {
  const list = [...new Set((words ?? []).flatMap((w) => [w, singular(w)]).filter((w) => /^[a-z]{2,}$/.test(w)))];
  if (!list.length) return new Set();
  const { rows } = await db.raw(
    `SELECT w FROM unnest($1::text[]) AS w
      WHERE EXISTS (SELECT 1 FROM entities WHERE ${TENANT_SQL} AND merged_into IS NULL AND data::text ~* ('\\m' || w || '\\M'))
         OR EXISTS (SELECT 1 FROM extractions WHERE ${TENANT_SQL} AND COALESCE(NULLIF(corrected_value, ''), value) ~* ('\\m' || w || '\\M'))
         OR EXISTS (SELECT 1 FROM documents WHERE ${TENANT_SQL} AND original_filename ~* ('\\m' || w || '\\M'))`,
    [list]
  );
  return new Set(rows.map((r) => r.w));
}

/** Every distinct 4+ letter word in the tenant's customer / address / equipment / technician data (for typo tolerance; loaded only when a decline is about to fire). */
async function tenantWords(db) {
  const { rows } = await db.raw(
    `SELECT DISTINCT lower(w) AS w FROM (
        SELECT regexp_split_to_table(coalesce(data->>'customer_name','') || ' ' || coalesce(data->>'service_address','') || ' ' || coalesce(data->>'manufacturer','') || ' ' || coalesce(data->>'model','') || ' ' || coalesce(data->>'vendor_name',''), '[^A-Za-z]+') AS w
          FROM entities WHERE ${TENANT_SQL} AND merged_into IS NULL LIMIT 60000) t
      WHERE length(w) >= 4 LIMIT 30000`, []);
  const { rows: tech } = await db.raw(`SELECT DISTINCT lower(COALESCE(NULLIF(corrected_value, ''), value)) AS v FROM extractions WHERE ${TENANT_SQL} AND field_key IN ('technician','vendor_name','customer_name') LIMIT 2000`, []);
  const out = new Set(rows.map((r) => r.w));
  for (const r of tech) for (const w of String(r.v ?? "").split(/[^a-z]+/)) if (w.length >= 4) out.add(w);
  return out;
}

/** @returns the honest out-of-scope decline, or null when any anchor exists or anything is unsure. */
export async function buildNoAnchorDecline(db, question) {
  if (!noAnchorEnabled()) return null;
  const raw = String(question ?? "").trim();
  if (!raw || raw.length > 160 || /[0-9@#$%_\\/]/.test(raw)) return null;
  if (isHelpQuestion(raw)) return null;
  const stripped = String(stripConversationalFrame(raw) ?? raw);
  const toks = contentTokens(stripped);
  if (!toks.length || toks.length > 8) return null;
  if (toks.some(staticAnchor)) return null;
  if ((await wordInOrgData(db, toks)).size) return null;
  const mine = await tenantWords(db);
  for (const t of toks) {
    if (t.length < 4) continue;
    const max = t.length >= 8 ? 2 : 1;
    for (const w of mine) if (Math.abs(w.length - t.length) <= max && damerauLevenshteinDistance(t, w) <= max) return null;
  }
  return buildOutOfDomainAnswer();
}
