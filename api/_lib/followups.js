/**
 * Missing-info follow-ups: nightly + on-demand automation that turns a
 * document sitting in Needs-attention with unresolved required fields into a
 * short, per-technician message asking for exactly what's missing (owner
 * brief, handoffs/START_HERE_NEXT_CHAT.md item 3; design in
 * handoffs/TECH_FOLLOWUPS_2026-09-21.md).
 *
 * Pure functions only — no DB, no Clerk, no network, no model call. The
 * database/Clerk/email work lives in api/_lib/routes/followups.js, which
 * calls into this file for every decision that can be tested without a
 * database (scripts/verify-followups.mjs) — same split as
 * api/_lib/outreach.js / api/_lib/routes/outreach.js.
 */
import { completenessFor, toCompletenessFields, fieldLabel } from "./documentTypes.js";

/** How many documents one technician's message lists by name before it just
 *  says "...and N more" — a backlog beyond this still gets ONE message, not
 *  an unbounded wall of filenames. */
export const FOLLOWUP_MAX_DOCS_PER_MESSAGE = 20;

/** How many technician messages one run (nightly or on-demand) will produce.
 *  A shop with a bigger backlog gets its loudest technicians (most documents
 *  due) this run; the debounce below means nobody is skipped forever — the
 *  rest are simply due again on the next run. */
export const FOLLOWUP_MAX_MESSAGES_PER_RUN = 50;

/** A technician who was already sent a follow-up gets at most one more per
 *  this many hours, per tenant. */
export const FOLLOWUP_DEBOUNCE_HOURS = 24;

/** Cap on tenants.settings.followupsLastSent's entry count — same
 *  FIFO-oldest-dropped tradeoff as recordsStore.js's KNOWN_SHOP_CONTACTS_CAP,
 *  for the same reason (an unbounded jsonb blob on the tenant row is not a
 *  thing to let grow forever). */
export const FOLLOWUP_LAST_SENT_CAP = 200;

/** Deep link every follow-up message points at — the technician's own Inbox,
 *  pre-filtered to their own work (src/hooks/useWorkFilter.ts honors
 *  `?work=mine` via src/hooks/useDeepLink.ts). */
export const FOLLOWUP_INBOX_LINK = "/app/?screen=inbox&work=mine";

/** Shape + default tenants.settings.followups ({enabled, email}) — off by
 *  default, admin-only to turn on (see api/_lib/routes/followups.js). */
export function shapeFollowupSettings(raw) {
  return {
    enabled: raw?.enabled === true,
    email: raw?.email === true,
  };
}

/** True exactly when this tenant's follow-up automation should do anything
 *  at all — the one gate every run (nightly or on-demand) checks first,
 *  before touching the database, so "disabled -> no-op" is directly
 *  testable with no fixtures beyond a settings object. */
export function shouldRunFollowups(settings) {
  return shapeFollowupSettings(settings).enabled === true;
}

function normalizeName(s) {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Mirrors src/core/workFilter.ts's technicianNameMatches exactly (kept as its
 * own small copy rather than importing frontend TS into the backend runtime —
 * see that file's own header for the full rationale of the matching rule
 * this restates: exact match, substring match, or last-name-alone-as-a-word).
 */
export function technicianNameMatches(technicianName, displayName) {
  const tech = normalizeName(technicianName);
  const me = normalizeName(displayName);
  if (!tech || !me) return false;
  if (tech === me || tech.includes(me)) return true;

  const meParts = me.split(" ").filter(Boolean);
  const lastName = meParts[meParts.length - 1];
  if (!lastName || lastName.length < 2) return false;
  const techTokens = tech.split(/[^a-z0-9]+/).filter(Boolean);
  return techTokens.includes(lastName);
}

/** The technician name a document's own extraction rows claim — a human
 *  correction wins over the raw AI value, same precedence
 *  documentTypes.js's toCompletenessFields() applies for completeness.
 *  @param {{field_key: string, value: unknown, corrected_value?: unknown}[]} extractions
 *  @returns {string|null} */
export function docTechnicianName(extractions) {
  for (const e of extractions ?? []) {
    if (e?.field_key !== "technician") continue;
    const corrected = e?.corrected_value;
    const raw = e?.value;
    const value = (corrected != null && String(corrected).trim() !== "" ? corrected : raw) ?? "";
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Required-field gaps for one document, reusing documentTypes.js's
 * completenessFor — the exact rule the Inbox's own "missing-field" issues
 * (src/core/entityGraph.ts's recomputeIssues) are built on, so a document
 * flagged here is a document a human would also see flagged in the Inbox.
 * @param {{document_type: string|null|undefined, extractions: object[]}} doc
 * @returns {string[]} requirement strings, e.g. "warranty_expires|warranty_term"
 */
export function missingFieldsForDocument(doc) {
  const fields = toCompletenessFields(doc?.extractions ?? []);
  return completenessFor(doc?.document_type, fields).missing;
}

/** One requirement string ("a|b") in plain, lowercase words joined by "or" —
 *  e.g. "warranty_expires|warranty_term" -> "warranty expires or term". */
export function missingFieldsPlainWords(missing) {
  return (missing ?? [])
    .map((req) => req.split("|").map((k) => fieldLabel(k).toLowerCase()).join(" or "))
    .join(", ");
}

/**
 * Which technician (or the admin) a needs-attention document belongs to.
 * Uploader identity always wins when it names a known member (documents.
 * uploaded_by, M3-config/20-document-uploaded-by.sql); otherwise the
 * document's own extracted `technician` field is matched against the member
 * roster's display names; otherwise it falls to the tenant's admin — the
 * brief's "unassigned -> the admin".
 * @param {{uploadedBy: string|null, technicianName: string|null}} doc
 * @param {{userId: string, displayName: string|null, email: string|null, isAdmin: boolean}[]} members
 * @returns {object|null} the member (or admin) responsible, or null if the
 *   roster has nobody to fall back to (no admin on file either)
 */
export function memberForDocument(doc, members) {
  const list = members ?? [];
  if (doc?.uploadedBy) {
    const byId = list.find((m) => m.userId === doc.uploadedBy);
    if (byId) return byId;
  }
  if (doc?.technicianName) {
    const byName = list.find((m) => technicianNameMatches(doc.technicianName, m.displayName));
    if (byName) return byName;
  }
  return list.find((m) => m.isAdmin) ?? null;
}

/**
 * Group needs-attention documents by the technician (or admin) responsible.
 * @param {{id, filename, uploadedBy, technicianName, missing: string[]}[]} docs
 *   already filtered to missing.length > 0
 * @param {object[]} members
 * @returns {Map<string, {member: object, docs: object[]}>} keyed by member.userId
 */
export function groupDocsByTechnician(docs, members) {
  const groups = new Map();
  for (const doc of docs ?? []) {
    if (!doc?.missing?.length) continue;
    const member = memberForDocument(doc, members);
    if (!member?.userId) continue; // nobody on the roster to tell — nothing this run can do
    if (!groups.has(member.userId)) groups.set(member.userId, { member, docs: [] });
    groups.get(member.userId).docs.push(doc);
  }
  return groups;
}

/** Groups sorted biggest-backlog-first and capped to
 *  FOLLOWUP_MAX_MESSAGES_PER_RUN — a shop with more overdue technicians than
 *  that gets the loudest ones this run; the 24h debounce means the rest are
 *  simply due again next run, never lost. */
export function selectGroupsForRun(groups, max = FOLLOWUP_MAX_MESSAGES_PER_RUN) {
  const list = groups instanceof Map ? [...groups.values()] : (groups ?? []);
  return [...list].sort((a, b) => b.docs.length - a.docs.length).slice(0, Math.max(0, max));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Render one technician's message. Deterministic, no model call.
 * @param {{docs: {filename: string, missing: string[]}[]}} group
 * @param {string} appUrl e.g. "https://deepwelltechnology.com"
 */
export function renderFollowupMessage({ docs }, appUrl) {
  const all = docs ?? [];
  const n = all.length;
  const shown = all.slice(0, FOLLOWUP_MAX_DOCS_PER_MESSAGE);
  const overflow = n - shown.length;
  const subject = `${n} document${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a detail from you`;
  const link = `${appUrl}${FOLLOWUP_INBOX_LINK}`;

  const lines = shown.map((d) => `${d.filename} — ${missingFieldsPlainWords(d.missing)}`);
  const textLines = [subject, "", ...lines.map((l) => `- ${l}`)];
  if (overflow > 0) textLines.push(`- …and ${overflow} more`);
  textLines.push("", `Open Inbox: ${link}`);

  const html =
    `<p><strong>${escapeHtml(subject)}</strong></p><ul>` +
    shown.map((d) => `<li>${escapeHtml(d.filename)} — ${escapeHtml(missingFieldsPlainWords(d.missing))}</li>`).join("") +
    (overflow > 0 ? `<li>…and ${overflow} more</li>` : "") +
    `</ul><p><a href="${link}">Open Inbox</a></p>`;

  return { subject, text: textLines.join("\n"), html, link, itemCount: n, shownCount: shown.length };
}

/** True when this member (`key` = userId) may receive another follow-up
 *  right now, given the tenant's last-sent map (tenants.settings.
 *  followupsLastSent, {userId: ISO string}). @param {Record<string,string>} lastSentMap */
export function canSendFollowup(lastSentMap, key, now = Date.now()) {
  const last = lastSentMap?.[key];
  if (!last) return true;
  const t = new Date(last).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t >= FOLLOWUP_DEBOUNCE_HOURS * 60 * 60 * 1000;
}

/** Merge one just-sent timestamp into the map, capped FIFO-oldest-dropped at
 *  FOLLOWUP_LAST_SENT_CAP entries (same tradeoff as recordsStore.js's
 *  known_shop_contacts). Pure — the caller persists the result. */
export function recordFollowupSent(lastSentMap, key, whenIso) {
  const merged = { ...(lastSentMap ?? {}), [key]: whenIso };
  const entries = Object.entries(merged).sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime());
  return Object.fromEntries(entries.slice(0, FOLLOWUP_LAST_SENT_CAP));
}
