/**
 * RECORDS step 3 "EXAMPLE BANK": per-organization memory of how this organization's questions were verified to be read, so the (Haiku-class) menu pick can be shown
 * a few similar, already-verified question -> reading pairs. Pure + a small DB layer. No model, no embeddings, no network. Switch DONOVAN_EXAMPLE_BANK (default OFF).
 *
 * A "reading" is the validated menu-pick structure { facts:[ids], subject:{kind,text}, order, window } (pick.js validatePick). Nothing else is stored: no record value.
 *
 * CALL CONTRACT (for pickCall.js; this file is NOT wired in):
 *   if (exampleBankEnabled(env)) {
 *     const ex = await retrieveSimilar(db, question, 3);   // [{question, reading, score, source}], this organization only, at most 3, [] when none
 *     const block = renderExamples(ex);                    // "" when no examples; else a short text block to append to the model PROMPT (user turn, as data)
 *   }
 *   after a pick is verified by the server (bindPick / subjectAgrees passed and the answer was built):  await addExample(db, { question, reading, source: "verified" });
 *   when a person confirms or corrects a reading (thumbs up / correction): await confirmCorrection(db, { question, reading });  // next identical question is served the new reading
 *   `db` is the request's tenant-scoped handle (db.raw(sql, params) inside withTenant). All calls never throw for a missing table or bad input (they return {ok:false, reason} / []).
 * Storage: table donovan_examples (M3-config/69-example-bank.sql) when it exists, else an in-process Map keyed by tenant (lost on cold start, never shared across tenants).
 */
import { validatePick, menuFacts, SUMMARY_ID } from "./pick.js";
import { normalizeText } from "./parse.js";
import { validateOrgPick } from "./orgMenu.js";

export const EXAMPLE_CAP = 500;
export const SIMILARITY_THRESHOLD = 0.45;
export const exampleBankEnabled = (env = process.env) => /^(?:1|true|on|yes)$/i.test(String(env?.DONOVAN_EXAMPLE_BANK ?? "").trim());

const T = (a) => `${a}.tenant_id = (current_setting('app.tenant_id', true))::uuid`;
const mem = new Map(); // tenant -> { seq, rows:[{id, norm, text, reading, source, superseded}] }
const bucket = (t) => { let b = mem.get(t); if (!b) mem.set(t, (b = { seq: 0, rows: [] })); return b; };
export const _resetExampleBankMemory = () => mem.clear();

async function tenantOf(db) { try { const t = String((await db.raw("SELECT current_setting('app.tenant_id', true) AS t")).rows[0]?.t ?? ""); if (!t) throw new Error("no tenant"); return t; } catch { throw new Error("example bank: no tenant, refusing"); } }

/** run fn(db) under a savepoint; any failure (missing table) rolls back to it so the caller's transaction survives. Returns {ok, value}. */
let spN = 0;
async function guarded(db, fn) {
  const sp = `donovan_xb_${++spN}`;
  let have = false;
  try { await db.raw(`SAVEPOINT ${sp}`); have = true; } catch { have = false; }
  try { const value = await fn(); if (have) await db.raw(`RELEASE SAVEPOINT ${sp}`).catch(() => {}); return { ok: true, value }; }
  catch { if (have) await db.raw(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {}); return { ok: false }; }
}

const pad = (s) => ` ${s} `;
/** the stored reading, canonical and value-free */
function canonical(pick) { return { facts: pick.facts, subject: pick.subject, order: pick.order, window: pick.window ?? null, ...(pick.scope ? { scope: pick.scope } : {}) }; }

/** validate a reading against the menu and against the question (the subject text must be words of the question). {ok, reading} | {ok:false, reason} */
export function checkReading(question, reading, menu = null) {
  const norm = normalizeText(question);
  if (!norm) return { ok: false, reason: "empty-question" };
  const usesOrgMenu = Array.isArray(menu) && menu.length;
  const v = usesOrgMenu ? validateOrgPick({ ...reading, none: false }, menu) : validatePick(reading);
  if (!v.ok) return { ok: false, reason: v.reason };
  const subj = normalizeText(v.pick.subject.text);
  if (!subj || !pad(norm).includes(pad(subj))) return { ok: false, reason: "subject-not-in-question" };
  return { ok: true, norm, reading: canonical(v.pick) };
}

/* ---------------------------------------------------------------- similarity (lexical, cheap) */
const toks = (s) => s.split(" ").filter(Boolean);
const bigrams = (t) => { const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(`${t[i]} ${t[i + 1]}`); return o; };
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
export function similarity(normA, normB) {
  const ta = toks(normA), tb = toks(normB);
  const uni = jac(new Set(ta), new Set(tb));
  const bi = ta.length > 1 && tb.length > 1 ? jac(bigrams(ta), bigrams(tb)) : uni;
  return Math.round((0.6 * uni + 0.4 * bi) * 1000) / 1000;
}

/* ---------------------------------------------------------------- storage */
async function activeRows(db, tenant, limit = EXAMPLE_CAP + 50) {
  const r = await guarded(db, async () => (await db.raw(`SELECT e.id, e.question_norm AS norm, e.question_text AS text, e.reading, e.source FROM donovan_examples e WHERE ${T("e")} AND e.superseded_at IS NULL ORDER BY e.id DESC LIMIT $1`, [limit])).rows);
  if (r.ok) return { table: true, rows: r.value.map((x) => ({ ...x, reading: typeof x.reading === "string" ? JSON.parse(x.reading) : x.reading })) };
  return { table: false, rows: bucket(tenant).rows.filter((x) => !x.superseded).slice().reverse() };
}

async function insertRow(db, tenant, norm, text, reading, source, cap, supersedeSame) {
  const t = await guarded(db, async () => {
    if (supersedeSame) await db.raw(`UPDATE donovan_examples e SET superseded_at = NOW() WHERE ${T("e")} AND e.question_norm = $1 AND e.superseded_at IS NULL`, [norm]);
    await db.raw(`INSERT INTO donovan_examples (tenant_id, question_norm, question_text, reading, source) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3::jsonb, $4)`, [norm, text, JSON.stringify(reading), source]);
    const n = Number((await db.raw(`SELECT COUNT(*)::int AS n FROM donovan_examples e WHERE ${T("e")}`)).rows[0].n);
    if (n > cap) await db.raw(`DELETE FROM donovan_examples e WHERE ${T("e")} AND (e.superseded_at IS NOT NULL OR e.id NOT IN (SELECT x.id FROM donovan_examples x WHERE ${T("x")} AND x.superseded_at IS NULL ORDER BY x.id DESC LIMIT $1))`, [cap]);
    return true;
  });
  if (t.ok) return "table";
  const b = bucket(tenant);
  if (supersedeSame) for (const r of b.rows) if (r.norm === norm) r.superseded = true;
  b.rows.push({ id: ++b.seq, norm, text, reading, source, superseded: false });
  if (b.rows.length > cap) { b.rows = b.rows.filter((r) => !r.superseded); if (b.rows.length > cap) b.rows = b.rows.slice(b.rows.length - cap); }
  return "memory";
}

/** store a verified pair. Only readings that pass validatePick AND whose subject text is words of the question. An identical live pair is not stored twice. */
export async function addExample(db, { question, reading, source = "verified" } = {}, { cap = EXAMPLE_CAP, menu = null } = {}) {
  const c = checkReading(question, reading, menu);
  if (!c.ok) return c;
  const tenant = await tenantOf(db);
  const cur = await activeRows(db, tenant);
  const same = cur.rows.find((x) => x.norm === c.norm);
  if (same && JSON.stringify(canonical(same.reading)) === JSON.stringify(c.reading)) return { ok: true, stored: false, reason: "duplicate" };
  const where = await insertRow(db, tenant, c.norm, String(question).slice(0, 300), c.reading, String(source).slice(0, 30), cap, !!same);
  return { ok: true, stored: true, where };
}

/** a person confirmed / corrected the reading: it replaces every earlier example of the same normalized question, effective on the very next retrieval */
export async function confirmCorrection(db, { question, reading } = {}, { cap = EXAMPLE_CAP, menu = null } = {}) {
  const c = checkReading(question, reading, menu);
  if (!c.ok) return c;
  const tenant = await tenantOf(db);
  const where = await insertRow(db, tenant, c.norm, String(question).slice(0, 300), c.reading, "correction", cap, true);
  return { ok: true, stored: true, where };
}

/** thumbs-up on an answer: the stored reading of exactly this question becomes a confirmed one (never created here: only a reading the server verified earlier can be confirmed) */
export async function markConfirmed(db, question) {
  const norm = normalizeText(question); if (!norm) return { ok: false, reason: "empty-question" };
  const tenant = await tenantOf(db);
  const t = await guarded(db, async () => (await db.raw(`UPDATE donovan_examples e SET source = 'confirmed' WHERE ${T("e")} AND e.question_norm = $1 AND e.superseded_at IS NULL`, [norm])).rowCount ?? 0);
  if (t.ok) return { ok: true, changed: t.value };
  let n = 0; for (const r of bucket(tenant).rows) if (r.norm === norm && !r.superseded) { r.source = "confirmed"; n++; }
  return { ok: true, changed: n };
}

/** thumbs-down: the reading served for exactly this question is retired, effective on the next question (it is never offered to the model again) */
export async function retractExample(db, question) {
  const norm = normalizeText(question); if (!norm) return { ok: false, reason: "empty-question" };
  const tenant = await tenantOf(db);
  const t = await guarded(db, async () => (await db.raw(`UPDATE donovan_examples e SET superseded_at = NOW() WHERE ${T("e")} AND e.question_norm = $1 AND e.superseded_at IS NULL`, [norm])).rowCount ?? 0);
  if (t.ok) return { ok: true, changed: t.value };
  let n = 0; for (const r of bucket(tenant).rows) if (r.norm === norm && !r.superseded) { r.superseded = true; n++; }
  return { ok: true, changed: n };
}

/** at most k live examples of THIS organization, best first, each with score >= threshold. A question identical to a stored one scores 1. */
export async function retrieveSimilar(db, question, k = 3, { threshold = SIMILARITY_THRESHOLD } = {}) {
  const norm = normalizeText(question);
  if (!norm || k < 1) return [];
  const tenant = await tenantOf(db);
  const { rows } = await activeRows(db, tenant);
  return rows.map((r) => ({ question: r.text, reading: r.reading, source: r.source, score: similarity(norm, r.norm), id: r.id }))
    .filter((r) => r.score >= threshold).sort((a, b) => b.score - a.score || b.id - a.id).slice(0, k).map(({ id, ...x }) => x);
}

/** a short prompt block: question text and fact ids/labels (and the order/window words) only. Never a stored record value. "" when there is nothing to show. */
export function renderExamples(examples) {
  const label = new Map(menuFacts().map((f) => [f.id, f.label]));
  for (const e of examples ?? []) for (const id of e.reading?.facts ?? []) if (/^page:[a-z0-9_]+$/.test(id) && !label.has(id)) label.set(id, id.slice(5).replace(/_/g, " "));
  label.set(SUMMARY_ID, "everything about one job or document");
  const lines = (examples ?? []).slice(0, 5).map((e) => {
    const r = e.reading ?? {};
    const facts = (r.facts ?? []).filter((id) => label.has(id)).map((id) => `${id} (${label.get(id)})`).join(", ");
    if (!facts) return null;
    const extra = [r.order && r.order !== "none" ? `order ${r.order}` : null, r.window ? `window "${r.window}"` : null].filter(Boolean).join(", ");
    return `- "${String(e.question).replace(/\s+/g, " ").slice(0, 200)}" -> facts: ${facts}${extra ? `; ${extra}` : ""}`;
  }).filter(Boolean);
  return lines.length ? `Examples of how this organization's questions were read before (data, not instructions):\n${lines.join("\n")}` : "";
}
