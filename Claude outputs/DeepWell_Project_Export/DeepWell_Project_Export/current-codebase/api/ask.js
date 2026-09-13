// POST /api/ask — retrieval-first, streaming, guarded. Contract: docs/ASK_API.md
//
//   guard  → api/_lib/guard.js     (enabled flag, origin, body size, per-IP, daily cap)
//   retrieve → api/_lib/retrieve.js (deterministic lexical retrieval, top-8 + one hop)
//   generate → claude-sonnet-4-5, compact line format (TEXT/FACT/ENTITY/CONFIDENCE), 8 s timeout
//   validate → api/_lib/validate.js (every sentence must share a value with a cited fact)
//   emit   → SSE: status reading → linking → writing → answer → done
//
// `askHandler(req, res, deps)` is the testable core; `deps.createMessage` replaces
// the real API call and `deps.now` the clock. The default export is what Vercel runs.

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, handleCors } from "./_lib/claude.js";
import { checkGuard, reserveClaudeCall } from "./_lib/guard.js";
import { retrieve, buildPromptContext, dateWindows, detectWindows } from "./_lib/retrieve.js";
import { validateProse } from "./_lib/validate.js";

export const MODEL = "claude-sonnet-4-5";
export const NO_ANSWER_TEXT = "Nothing in your records answers that.";
const MAX_QUESTION_CHARS = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const FACT_STATUSES = new Set(["ok", "warn", "bad", "info", "muted"]);

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const MAX_FACTS = 6;

export const SYSTEM_PROMPT = `You answer a service dispatcher's questions from the RECORDS in the message: JSON records (property, equipment, service visit, customer, technician), each with an id, label and fields. A visit's \`at\` is the property it happened at and \`unit\` the equipment; an equipment record's \`at\` is its property; \`related\` holds the ids. A field's \`src\` lists the refs ("s12") of the documents it came from. Date fields carry \`iso\`, \`when\` ("in 238 days" = future, "546 days ago" = past) and \`within\` — the named windows from the WINDOWS line that the date falls inside.

RULES
1. Use only RECORDS. Never use outside knowledge and never invent a date, serial, price, name, count or ref. Copy values exactly as written.
2. Every fact cites the one src ref of the field its value came from (for a visit, its date field's ref). A fact with no ref is dropped.
3. Warranty from warrantyExpiry \`when\`: "in N days" = under warranty; "N days ago" = expired; empty value = no warranty on file — neither active nor expired. "Out of warranty" and "expired" mean an expired date only: units with no warranty on file are reported as "no warranty on file" and never counted among the expired. When the message has a WARRANTY SUMMARY, its buckets and counts are authoritative.
4. Windows: when the message has an IN WINDOW line for the period the question asks about, that list is authoritative — exactly those records (and no others) fall in the window; apply the question's other filters (technician, place, make, type) to that list and use its count and total. Otherwise a date is in a named window only if that exact name appears in its \`within\`. "Soon" and "expiring" = "next 90 days"; "expired this year" = an expired date inside "this year". Never substitute the nearest record outside the window.
5. Visits: a visit's property is its \`at\`; its technician is technicianName. A first name alone means the technician with that first name; "the Johnson place" means the property whose customerName is Johnson. "Last visit" / "last serviced" / "most recent" = the visit with the smallest "N days ago" among visits at that property or on that unit — give date, technician, work performed and cost. Any question about a technician's work lists each matching visit with date, work and cost, and when there are several ends TEXT with the total ("$690 across 2 visits").
6. Filter, then count: keep only records matching every filter in the question (technician, place, window, manufacturer, equipment type); state the count of ALL matching records as a digit ("2 visits", "7 units", "3 Rheem units") even when fewer are listed as facts. For spend across visits give the number of billed visits and the total. If a technician's filtered visits come to nothing, answer NONE naming the technician, the place and the period (e.g. "Maria Santos has no recorded visits at 4321 S Price Rd last winter.").
7. A warranty window with no matches is still an answer: say none expire in that window and name only the single next upcoming expiry (smallest "in N days") as a fact. When there are matches, mention only the matching units.
8. A property question covers every unit at that property. If the question names a kind of unit ("the furnace", "the heat pump") and exactly one unit there matches, answer about that one; otherwise report each unit and say how many units there are and how many are under warranty ("neither"/"none" when 0).
9. A bare address, name, serial or model number with no question asks for the full story. TEXT follows "<customer> at <address> has <n> units, <k> under warranty, and <m> service visits on file; last visit <date> by <technician>, <work>, $<cost>." FACT lines: customer, each unit (make + type + serial, warranty status), each visit (newest first). Name a unit the way its label reads — make then type, e.g. "Lennox Furnace" — followed by its serial.
10. FACT lines: at most ${MAX_FACTS}. One per matching record for list questions, newest first; when more than ${MAX_FACTS} match, list the ${MAX_FACTS} newest and put the total count in TEXT. Label ≤ 4 words (a date for a visit, make + type + serial for a unit), value ≤ 8 words, exactly one ref. ENTITY is the primary record (the property for address questions, the technician for "what did X do" questions, the unit for serial questions).
11. TEXT: what a dispatcher would say out loud, ≤ 35 words — one sentence for list questions (the count plus the total or the newest item), at most two otherwise — carrying the concrete values (dates as "Mon D, YYYY", $ amounts, full names, full addresses, counts as digits). No background or commentary; never mention refs, ids, iso, when or within.
12. If nothing in RECORDS answers the question, output only NONE: ${NO_ANSWER_TEXT}

OUTPUT FORMAT — plain text, one item per line, no other prose, no markdown:
TEXT: <the answer>
FACT: <label> | <value> | <ref>
ENTITY: <primary record id>
CONFIDENCE: <0–1>
or, when there is no answer, a single line:
NONE: <one sentence>`;

/**
 * Parse the model's line format into { answerable, text, facts, entityId, confidence }.
 * Tolerant: unknown lines are ignored, TEXT may wrap onto following untagged lines,
 * refs may be separated by spaces or commas. Nothing usable → answerable=false.
 */
export function parseModelText(raw) {
  const out = { answerable: true, text: "", facts: [], confidence: undefined, entityId: undefined };
  let none = null;
  let mode = null; // "text" while untagged lines continue TEXT
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const m = /^\s*(TEXT|FACT|ENTITY|CONFIDENCE|NONE)\s*:\s*(.*)$/i.exec(line);
    if (!m) {
      if (mode === "text" && line.trim()) out.text += ` ${line.trim()}`;
      continue;
    }
    const tag = m[1].toUpperCase();
    const rest = m[2].trim();
    mode = null;
    if (tag === "TEXT") {
      out.text = out.text ? `${out.text} ${rest}` : rest;
      mode = "text";
    } else if (tag === "FACT") {
      const parts = rest.split("|").map((p) => p.trim());
      if (parts.length < 2) continue;
      const refs = (parts[2] ?? "").split(/[\s,;]+/).filter((r) => /^s\d+$/i.test(r)).map((r) => r.toLowerCase());
      out.facts.push({ label: parts[0], value: parts[1], sources: refs });
    } else if (tag === "ENTITY") out.entityId = rest.split(/\s+/)[0];
    else if (tag === "CONFIDENCE") {
      const n = Number.parseFloat(rest);
      if (Number.isFinite(n)) out.confidence = n > 1 ? n / 100 : n;
    } else if (tag === "NONE") none = rest;
  }
  if (none !== null && !out.facts.length) return { answerable: false, text: none || NO_ANSWER_TEXT, facts: [], confidence: 0 };
  if (!out.text && !out.facts.length) return { answerable: false, text: NO_ANSWER_TEXT, facts: [], confidence: 0 };
  return out;
}

/** Concatenated text blocks of a Messages API response. */
export function responseText(response) {
  if (!Array.isArray(response?.content)) return "";
  return response.content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}


// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function parseBody(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString("utf8");
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  return b && typeof b === "object" && !Array.isArray(b) ? b : null;
}

/** Validate the request per docs/ASK_API.md. Returns { ok:true, body } or { ok:false, error }. */
export function validateBody(raw, now) {
  if (!raw) return { ok: false, error: "Body must be a JSON object" };
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return { ok: false, error: "Missing question" };
  if (question.length > MAX_QUESTION_CHARS) return { ok: false, error: `Question longer than ${MAX_QUESTION_CHARS} characters` };
  if (!Array.isArray(raw.records)) return { ok: false, error: "Missing records" };
  const records = raw.records.filter((r) => r && typeof r === "object" && typeof r.entityId === "string" && r.fields && typeof r.fields === "object");
  const today = typeof raw.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.today) ? raw.today : new Date(now).toISOString().slice(0, 10);
  return {
    ok: true,
    body: {
      question,
      includeUnverified: raw.includeUnverified === true,
      today,
      records,
      heldBack: Array.isArray(raw.heldBack) ? raw.heldBack.filter((h) => h && typeof h.documentId === "string") : [],
      docs: Array.isArray(raw.docs) ? raw.docs.filter((d) => d && typeof d.documentId === "string") : [],
    },
  };
}

/** FNV-1a over a string — cheap, deterministic, good enough for a cache key. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const normalizeQuestion = (q) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function cacheKey(body) {
  const payload = hashString(JSON.stringify(body.records) + "|" + JSON.stringify(body.heldBack) + "|" + body.today);
  return `${normalizeQuestion(body.question)}|${body.includeUnverified ? 1 : 0}|${payload}`;
}

const cache = new Map(); // key → { answer, expires }

export function resetAskCacheForTests() {
  cache.clear();
}

function cacheGet(key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= now) {
    cache.delete(key);
    return null;
  }
  return hit.answer;
}

function cacheSet(key, answer, now) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { answer, expires: now + CACHE_TTL_MS });
}

function sendJson(res, status, body, headers = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  return res.status(status).json(body);
}

function openStream(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

function timeoutMs(deps) {
  if (typeof deps.timeoutMs === "number") return deps.timeoutMs;
  const n = Number.parseInt(process.env.ASK_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

let client = null;
function defaultCreateMessage(params, { signal, timeout }) {
  if (!client) client = new Anthropic({ apiKey: getApiKey() });
  return client.messages.create(params, { signal, timeout });
}

/** Run the model call with a hard deadline; rejects with an Error named TimeoutError. */
async function callWithTimeout(createMessage, params, ms) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`Answer took longer than ${ms} ms`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([createMessage(params, { signal: controller.signal, timeout: ms }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Answer shaping
// ---------------------------------------------------------------------------

const locKey = (documentId, loc) => `${documentId}|${loc?.page ?? ""}|${loc?.field ?? ""}`;

/** Excerpts were stripped from the prompt; put them back on cited sources. */
function excerptIndex(entities) {
  const byLoc = new Map();
  const byDoc = new Map();
  for (const rec of entities) for (const f of Object.values(rec.fields ?? {})) for (const s of f?.sources ?? []) {
    if (!s?.documentId) continue;
    if (s.excerpt && !byLoc.has(locKey(s.documentId, s.location))) byLoc.set(locKey(s.documentId, s.location), s.excerpt);
    if (s.excerpt && !byDoc.has(s.documentId)) byDoc.set(s.documentId, s.excerpt);
  }
  return { byLoc, byDoc };
}

function cleanSource(s, allowedDocs, excerpts) {
  if (!s || typeof s.documentId !== "string" || !allowedDocs.has(s.documentId)) return null;
  const location = {};
  if (typeof s.location?.page === "number" && Number.isFinite(s.location.page)) location.page = s.location.page;
  if (typeof s.location?.field === "string" && s.location.field) location.field = s.location.field;
  const out = { documentId: s.documentId, location };
  const excerpt = (typeof s.excerpt === "string" && s.excerpt) || excerpts.byLoc.get(locKey(s.documentId, location)) || excerpts.byDoc.get(s.documentId);
  if (excerpt) out.excerpt = excerpt;
  return out;
}

/** A cited source is either a ref ("s12") into the prompt context or a full SourceRef; anything else is dropped. */
function resolveSource(s, ctx, excerpts) {
  if (typeof s === "string") {
    const ref = ctx.prompt?.refs?.get(s.trim());
    return ref ? { ...ref, location: { ...ref.location } } : null;
  }
  return cleanSource(s, ctx.docIds, excerpts);
}

/** Enforce sourcing: drop citations outside the retrieved context, then facts left with no source. */
export function shapeFacts(rawFacts, ctx) {
  const entityIds = new Set(ctx.retrievalIds);
  const excerpts = excerptIndex(ctx.entities);
  const out = [];
  for (const f of Array.isArray(rawFacts) ? rawFacts : []) {
    if (!f || typeof f.label !== "string" || f.value === undefined || f.value === null) continue;
    const seen = new Set();
    const sources = [];
    for (const s of Array.isArray(f.sources) ? f.sources : []) {
      const c = resolveSource(s, ctx, excerpts);
      if (!c) continue;
      const k = locKey(c.documentId, c.location);
      if (seen.has(k)) continue;
      seen.add(k);
      sources.push(c);
    }
    if (!sources.length) continue;
    const fact = { label: f.label.trim(), value: String(f.value).trim(), sources };
    const owner = firstRef(f.sources) ? ctx.prompt?.refField?.get(firstRef(f.sources)) : undefined;
    const status = deriveStatus(owner) ?? (FACT_STATUSES.has(f.status) ? f.status : "info");
    fact.status = status;
    if (typeof f.entityId === "string" && entityIds.has(f.entityId)) fact.entityId = f.entityId;
    else if (owner && entityIds.has(owner.entityId)) fact.entityId = owner.entityId; // the record whose field the citation came from
    out.push(fact);
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

const firstRef = (sources) => (Array.isArray(sources) ? sources.find((s) => typeof s === "string")?.trim() : undefined);

/** Status comes from the cited field, not the model: a warranty date is ok / warn (≤ 90 days) / bad (past) / muted (none on file). */
function deriveStatus(owner) {
  if (!owner || !/warranty/i.test(owner.field ?? "")) return owner ? "info" : null;
  if (owner.empty) return "muted";
  if (typeof owner.days !== "number") return "info";
  if (owner.days < 0) return "bad";
  return owner.days <= 90 ? "warn" : "ok";
}

function unionSources(facts) {
  const seen = new Set();
  const out = [];
  for (const f of facts) for (const s of f.sources) {
    const k = locKey(s.documentId, s.location);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

const hasFieldValues = (rec) => Object.values(rec?.fields ?? {}).some((f) => f && f.value !== undefined && f.value !== null && f.value !== "");

/**
 * Held-back (linked, unverified) documents that would have added something:
 * they touch a retrieved entity AND at least one of their entities has no
 * verified fields at all (an empty service record, or one absent from the
 * export). A nameplate photo that merely repeats a serial the registration
 * already verifies is linked, but it does not change the answer.
 */
export function unverifiedCount(body, ctx) {
  const retrieved = new Set(ctx.retrievalIds);
  const known = new Map((body.records ?? []).map((r) => [r.entityId, hasFieldValues(r)]));
  let n = 0;
  for (const h of body.heldBack ?? []) {
    const ids = Array.isArray(h.entityIds) ? h.entityIds : [];
    if (!ids.some((id) => retrieved.has(id))) continue;
    if (ids.some((id) => known.get(id) !== true)) n++;
  }
  return n;
}

function noAnswer(body, ctx, extra) {
  return {
    kind: "no-answer",
    text: NO_ANSWER_TEXT,
    facts: [],
    sources: [],
    confidence: 0,
    verifiedCount: 0,
    unverifiedCount: unverifiedCount(body, ctx),
    closest: ctx.closest,
    retrievalIds: ctx.retrievalIds,
    validatorStrikes: 0,
    cached: false,
    ...extra,
  };
}

/** Turn the model's tool input into a validated Answer. */
export function buildAnswer(raw, body, ctx) {
  const input = raw && typeof raw === "object" ? raw : {};
  const facts = input.answerable === false ? [] : shapeFacts(input.facts, ctx);
  const validated = validateProse(typeof input.text === "string" ? input.text : "", facts);
  const strikes = validated.strikes;

  if (!facts.length) {
    // No sourced facts: the no-answer path, keeping the model's hedge only if the validator let it through.
    const text = validated.text && validated.text !== NO_ANSWER_TEXT ? validated.text : NO_ANSWER_TEXT;
    return { answer: noAnswer(body, ctx, { text, validatorStrikes: strikes }), removed: validated.removed };
  }

  // Facts survived but every sentence was struck: say the facts plainly rather than nothing.
  const text = validated.text || facts.slice(0, 3).map((f) => `${f.label}: ${f.value}.`).join(" ");
  const entityIds = new Set(ctx.retrievalIds);
  const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence) ? Math.min(1, Math.max(0, input.confidence)) : 0.8;
  const answer = {
    kind: "answer",
    text,
    facts,
    sources: unionSources(facts),
    confidence,
    verifiedCount: new Set(facts.flatMap((f) => f.sources.map((s) => s.documentId))).size,
    unverifiedCount: unverifiedCount(body, ctx),
    closest: ctx.closest,
    retrievalIds: ctx.retrievalIds,
    validatorStrikes: strikes,
    cached: false,
  };
  if (typeof input.entityId === "string" && entityIds.has(input.entityId)) answer.entityId = input.entityId;
  else if (facts[0]?.entityId) answer.entityId = facts[0].entityId;
  return { answer, removed: validated.removed };
}

/** The relative windows a dispatcher uses, spelled out so the model matches names instead of doing calendar math. */
export function windowsLine(today) {
  const w = dateWindows(today);
  if (!w.length) return "";
  return `WINDOWS (inclusive; each date's "within" lists the ones it falls in): ${w.map((x) => `${x.name} = ${x.from}..${x.to}`).join("; ")}`;
}

const WARRANTY_Q = /\b(warrant(y|ies)|expir(e|es|ed|ing|y)|cover(ed|age)?)\b/i;
const INSTALL_Q = /\binstall(ed|ation|s)?\b/i;
const moneyOf = (v) => {
  const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(String(v ?? ""));
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

/**
 * For each window the question names, the records whose relevant date falls
 * inside it — visits by `date`, units by `warrantyExpiry` (or `installDate`
 * for install questions). Deterministic, so the model composes instead of
 * filtering thirty records by hand.
 */
export function windowHints(question, records, today) {
  const windows = detectWindows(question, today);
  if (!windows.length) return "";
  const warranty = WARRANTY_Q.test(question);
  const install = !warranty && INSTALL_Q.test(question);
  const lines = [];
  for (const w of windows) {
    const visits = [];
    const units = [];
    for (const r of records) {
      if (r.type === "service") {
        const iso = r.fields?.date?.iso;
        if (iso && iso >= w.from && iso <= w.to) visits.push(r);
      } else if (r.type === "equipment" && (warranty || install)) {
        const key = warranty ? "warrantyExpiry" : "installDate";
        const iso = r.fields?.[key]?.iso;
        if (iso && iso >= w.from && iso <= w.to) units.push({ r, key });
      }
    }
    const parts = [];
    if (visits.length) {
      const costs = visits.map((r) => moneyOf(r.fields?.cost?.value)).filter((n) => n !== null);
      const total = costs.length === visits.length ? ` — ${visits.length} visit${visits.length === 1 ? "" : "s"}, $${costs.reduce((a, b) => a + b, 0).toLocaleString("en-US")} total` : ` — ${visits.length} visit${visits.length === 1 ? "" : "s"}`;
      parts.push(`visits: ${visits.map((r) => `${r.id} (${r.fields.date.value}${r.fields?.cost?.value ? `, ${r.fields.cost.value}` : ""})`).join("; ")}${total}`);
    }
    if (units.length) parts.push(`units by ${units[0].key}: ${units.map(({ r, key }) => `${r.id} (${r.fields[key].value})`).join("; ")} — ${units.length} unit${units.length === 1 ? "" : "s"}`);
    lines.push(`IN WINDOW "${w.name}" (${w.from}..${w.to}): ${parts.length ? parts.join(". ") : "no record dates fall in it"}. No other RECORDS date falls in this window.`);
  }
  return lines.join("\n");
}

/**
 * For warranty questions over several units: the three buckets, computed
 * server-side from `when`, so counts never depend on how many facts fit.
 */
export function warrantySummary(question, records) {
  if (!WARRANTY_Q.test(question)) return "";
  const units = records.filter((r) => r.type === "equipment");
  if (units.length < 3) return "";
  const expired = [];
  const active = [];
  const none = [];
  for (const r of units) {
    const f = r.fields?.warrantyExpiry;
    const name = `${r.id} (${r.label ?? r.id}${f?.value ? `, ${f.value}` : ""})`;
    if (!f || f.value === "" || f.value === null || f.value === undefined) none.push(name);
    else if (typeof f.when === "string" && f.when.endsWith("ago")) expired.push(name);
    else active.push(name);
  }
  const bucket = (label, list) => `${label}: ${list.length ? list.join("; ") : "none"} — ${list.length} unit${list.length === 1 ? "" : "s"}`;
  return `WARRANTY SUMMARY of the ${units.length} units in RECORDS. ${bucket("EXPIRED (out of warranty)", expired)}. ${bucket("UNDER WARRANTY", active)}. ${bucket("NO WARRANTY ON FILE", none)}.`;
}

export function buildMessages(body, ctx) {
  const prompt = ctx.prompt ?? buildPromptContext(ctx.entities, body.today, body.records);
  const held = unverifiedCount(body, ctx);
  const heldNote = held ? `\n${held} related document${held === 1 ? " is" : "s are"} held back as unverified and not in RECORDS; do not guess at ${held === 1 ? "it" : "them"}.` : "";
  const hints = [windowHints(body.question, prompt.records, body.today), warrantySummary(body.question, prompt.records)].filter(Boolean).join("\n");
  return [
    {
      role: "user",
      content: `TODAY: ${body.today}
${windowsLine(body.today)}${hints ? `\n${hints}` : ""}
RECORDS come from ${body.includeUnverified ? "verified and linked documents" : "verified documents only"}.${heldNote}
${JSON.stringify(prompt.records)}

QUESTION: ${body.question}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function askHandler(req, res, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const started = now();

  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const guard = await checkGuard(req, { now: started });
  if (!guard.ok) return sendJson(res, guard.status, guard.body, guard.headers);
  const ip = guard.ip;

  const parsed = validateBody(parseBody(req), started);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const body = parsed.body;
  const qlog = body.question.slice(0, 80);

  handleCors(res, req);
  const emit = openStream(res);
  const finish = (answer, extra = {}) => {
    emit("answer", { text: answer.text });
    emit("done", answer);
    res.end();
    console.log(JSON.stringify({ ask: "done", ip, ms: answer.latencyMs, entities: answer.retrievalIds?.length ?? 0, strikes: answer.validatorStrikes ?? 0, kind: answer.kind, cached: answer.cached === true, q: qlog, ...extra }));
  };

  try {
    emit("status", { stage: "reading" });

    const key = cacheKey(body);
    const hit = cacheGet(key, started);
    if (hit) {
      emit("status", { stage: "linking", entities: hit.retrievalIds?.length ?? 0, docs: hit.verifiedCount ?? 0 });
      emit("status", { stage: "writing" });
      return finish({ ...hit, cached: true, latencyMs: now() - started });
    }

    const ctx = retrieve(body.question, body);
    emit("status", { stage: "linking", entities: ctx.entities.length, docs: ctx.docIds.size });

    if (!ctx.entities.length) {
      // Nothing to reason over: no model call, no daily-cap slot.
      const answer = noAnswer(body, ctx, { latencyMs: now() - started });
      cacheSet(key, answer, started);
      return finish(answer, { reason: "no-retrieval" });
    }

    const slot = await reserveClaudeCall(started);
    if (!slot.ok) {
      for (const [k, v] of Object.entries(slot.headers ?? {})) res.setHeader(k, v);
      emit("error", { status: slot.status, ...slot.body });
      return res.end();
    }

    emit("status", { stage: "writing" });
    const createMessage = deps.createMessage ?? defaultCreateMessage;
    const params = {
      model: MODEL,
      max_tokens: 600,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: buildMessages(body, ctx),
    };

    let response;
    try {
      response = await callWithTimeout(createMessage, params, timeoutMs(deps));
    } catch (err) {
      const reason = err?.name === "TimeoutError" ? "timeout" : "api-error";
      console.error(JSON.stringify({ ask: reason, ip, ms: now() - started, message: String(err?.message ?? err).slice(0, 200) }));
      return finish(noAnswer(body, ctx, { latencyMs: now() - started }), { reason });
    }

    const rawText = responseText(response);
    if (process.env.ASK_DEBUG_RAW === "true") console.error(JSON.stringify({ ask: "raw", stop: response?.stop_reason, usage: response?.usage, text: rawText }));
    if (response?.stop_reason === "max_tokens") console.warn(JSON.stringify({ ask: "truncated", ip, q: qlog }));
    const { answer, removed } = buildAnswer(parseModelText(rawText), body, ctx);
    answer.latencyMs = now() - started;
    if (removed.length) console.warn(JSON.stringify({ ask: "validator", ip, removed: removed.map((s) => s.slice(0, 120)) }));
    cacheSet(key, answer, started);
    const usage = response?.usage ? { in: response.usage.input_tokens, out: response.usage.output_tokens } : {};
    return finish(answer, usage);
  } catch (err) {
    console.error(JSON.stringify({ ask: "error", ip, message: String(err?.message ?? err).slice(0, 200) }));
    emit("error", { status: 500, error: "Answer service failed" });
    return res.end();
  }
}

export default function handler(req, res) {
  return askHandler(req, res);
}
