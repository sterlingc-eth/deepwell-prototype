/**
 * vr_guard - two stricter-only guards (both default OFF; they can only turn an answer into an abstain / pointer, never the reverse).
 *  H328 revchain328: version groups across documents. An answer read from a document that has a newer (or unordered, value-differing) sibling revision is withheld.
 *  H327 absence_audit327: before any "not on file" statement, sweep raw page text and filenames of ALL stored documents (read or not) for the asked ID.
 * Pure functions, no I/O, no model. Flags: DONOVAN_REVCHAIN, DONOVAN_ABSAUDIT (1/true/on/yes).
 */
const on = (k) => /^(?:1|true|on|yes)$/i.test(String(process.env[k] ?? "").trim());
export const revchainOn = () => on("DONOVAN_REVCHAIN");
export const absAuditOn = () => on("DONOVAN_ABSAUDIT");

const alnum = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const toks = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const stemOf = (f) => String(f ?? "").toLowerCase().replace(/^batch\d+__/, "").replace(/\.[a-z0-9]{2,4}$/, "").replace(/[_\-. ](revised|revision|rev[a-z0-9]?|amended|amendment\d*|final|copy|updated|reissued|superseded|void|old|v\d+)(?=[_\-. ]|$)/g, "").replace(/[^a-z0-9]+/g, "");
const NEWER = /\b(revised|revision|supersedes|supersede|replaces|replacing|amended|amendment|reissued|re-issued|updated copy|corrected copy|rev\.? ?[b-z]|version [2-9]|v[2-9])\b/i;
const BANNER = /(^|\n)\W*(revised|amended|corrected|reissued|re-issued|updated|revision|rev\.? ?[b-z0-9]\b|version [2-9]|v[2-9]\b)|\b(supersedes|replaces|replacing)\b/i;
const NEWER_FILE = /(revis|[_\-.]rev[b-z0-9]?[_\-.]|amend|reissu|[_\-.]v[2-9]|corrected)/i;
const OBSOLETE = /\b(superseded by|void|obsolete|replaced by|no longer valid|cancelled|canceled)\b/i;
const VERSION_Q = /\b(original|earlier|previous|prior|old|older|first|initial|rev(?:ision)?\s?[a-z0-9]|version|v\d|as of|before|superseded|history)\b/i;
const DATE_ISO = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function firstDate(t) {
  const s = String(t).slice(0, 700); let m = s.match(DATE_ISO); if (m) return +m[1] * 10000 + +m[2] * 100 + +m[3];
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2}),? (20\d{2})\b/i); if (m) return +m[3] * 10000 + MON[m[1].toLowerCase()] * 100 + +m[2];
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/); if (m) return +m[3] * 10000 + +m[1] * 100 + +m[2];
  return 0;
}
const MONYR = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\d{0,4}$/;
const idTokens = (s) => { const out = []; for (const m of String(s).matchAll(/(?<![A-Za-z0-9])[A-Za-z]{2,6}[-_#]\d[A-Za-z0-9-]{2,}(?![A-Za-z0-9])/g)) { const a = alnum(m[0]); if (a.length >= 5 && /^[a-z]{2,6}\d{3,}/.test(a) && !MONYR.test(a) && !/^[a-z]{2}\d{5}$/.test(a) && !/^(fy|q[1-4]|h[12])\d/.test(a) && !out.includes(a)) out.push(a); } return out; };

/** Build version groups once per corpus: file -> { head, stem, ids, newerMark, obsolete, date }, and sibling lists. */
export function buildRevIndex(docs) {
  const files = new Map();
  for (const d of docs) {
    const f = d.file ?? ""; let e = files.get(f);
    if (!e) { e = { file: f, pages: [], head: "" }; files.set(f, e); }
    e.pages.push(d); if (d.page_no == null || d.page_no <= 1 || !e.head) e.head = String(d.text ?? "").slice(0, 700);
  }
  for (const e of files.values()) {
    e.text = e.pages.map((p) => p.text ?? "").join("\n"); e.norm = e.text.toLowerCase().replace(/[$,]/g, "");
    e.stem = stemOf(e.file); e.ids = idTokens(e.file + " " + e.head); e.primary = e.ids[0] ?? null;
    const top = e.head.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n"); e.newer = BANNER.test(top) || NEWER_FILE.test(e.file); e.obsolete = OBSOLETE.test(top); e.amend = /amend/i.test(top) && !/\b(revised|corrected|reissued|re-issued|supersedes the earlier)/i.test(top); e.date = firstDate(e.head);
    e.title = alnum((e.head.split("\n").find((l) => l.trim()) ?? "").replace(NEWER, "").replace(/\b(copy|supersedes[^.]*\.|use this one\.?)\b/gi, ""));
  }
  const byId = new Map();
  for (const e of files.values()) if (e.primary) (byId.get(e.primary) ?? byId.set(e.primary, []).get(e.primary)).push(e);
  const sib = new Map();
  for (const e of files.values()) {
    const s = new Set();
    for (const o of byId.get(e.primary) ?? []) if (o !== e && (o.stem === e.stem || (o.title && o.title === e.title))) s.add(o);
    if (e.stem.length >= 6) for (const o of files.values()) if (o !== e && o.stem === e.stem) s.add(o);   // same file stem once revision/copy words are removed
    sib.set(e.file, [...s]);
  }
  return { files, sib };
}

const valIn = (e, ans) => { const v = String(ans ?? "").toLowerCase().replace(/[$,]/g, "").trim(); return v.length > 0 && e.norm.includes(v); };

/** True if an answer taken from `file` is safe w.r.t. sibling revisions. */
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelDiffers = (o, label, ans) => { const l = String(label ?? "").trim(); if (l.length < 3) return true; const m = o.text.match(new RegExp("^\\s*" + esc(l) + "\\s*[:\\t|=-]\\s*(.+)$", "im")); if (!m) return false; return !valIn({ norm: m[1].toLowerCase().replace(/[$,]/g, "") }, ans); };
export function revisionSafe(idx, file, ans, question, label) {
  const e = idx.files.get(file); if (!e) return true;
  const sibs = idx.sib.get(file) ?? []; if (!sibs.length) return true;
  if (VERSION_Q.test(String(question ?? ""))) return true;
  const newerSibs = sibs.filter((o) => (o.newer && !e.newer) || (e.obsolete && !o.obsolete) || (o.date && e.date && o.date > e.date && !(e.newer && !o.newer)));
  if (e.newer && !newerSibs.length && !sibs.some((o) => o.newer && o.date > e.date)) return true;    // answered from the newest marked revision
  const check = newerSibs.length ? newerSibs : sibs;                                                   // unordered siblings: the value must agree everywhere
  return check.every((o) => (o.amend ? !labelDiffers(o, label, ans) : valIn(o, ans)));
}

/** H328 wrapper: result r from readValue -> r, or an abstain when a sibling revision could make the value stale. */
export function guardRevision(corpus, question, r) {
  if (!r || r.ans == null) return r;
  const idx = (corpus._revIdx ??= buildRevIndex(corpus.docs));
  const srcFiles = new Set([r.doc, ...(Array.isArray(r.sources) ? r.sources.map((x) => x.doc) : [])].filter((x) => x != null));
  for (const f of srcFiles) if (!revisionSafe(idx, f, r.ans, question, r.label)) return { ans: null, why: "revchain328" };
  return r;
}

/** H327: sweep raw text + filenames of ALL docs for the IDs the question asks about. pages = [{docId,file,page_no,text}] (unread documents included). */
const CONF = (k) => k.replace(/[il1]/g, "1").replace(/[o0]/g, "0");
export function absenceAudit(pages, question) {
  const q = String(question ?? ""); const want = new Set();
  for (const m of q.matchAll(/\b[A-Za-z]{1,6}[-_ #]?\d[\w-]{2,}\b/g)) { const a = alnum(m[0]); if (a.length >= 5 && /\d/.test(a) && /[a-z]/.test(a) && !/^(fy|q[1-4]|h[12])\d*$/.test(a) && !/^(20\d{2})/.test(a)) want.add(a); }
  if (!want.size) return { hit: false, keys: [] };
  const wantC = new Map([...want].map((k) => [CONF(k), k])); const hits = [];
  for (const p of pages) {
    const stream = [...toks(p.file), ...toks(p.text)]; const seen = new Set(); const n = stream.length;
    for (let i = 0; i < n; i++) { let cat = ""; for (let w = 0; w < 4 && i + w < n; w++) { cat += stream[i + w]; if (cat.length > 24) break; const k = wantC.get(CONF(cat)); if (k && !seen.has(k)) { seen.add(k); hits.push({ key: k, file: p.file, docId: p.docId, page: p.page_no }); } } }
  }
  return { hit: hits.length > 0, keys: [...want], hits };
}
export const ABSENT_RE = /(?:^|\b)(?:no [a-z0-9 .\-#]{1,60} on file|nothing on file|not on file|no stored document|no record(?:s)? (?:of|for)|isn'?t on file|couldn'?t find|could not find|no .{1,40} found)\b/i;
/** Pointer text used instead of a "not on file" claim; claims no value. */
export const pointerText = (hit, question = "") => `A stored document matches ${(String(question).match(/(?<![A-Za-z0-9])[A-Za-z]{1,6}[-_#]?\d[A-Za-z0-9-]{2,}/g) ?? []).find((x) => alnum(x) === hit.hits[0].key) ?? hit.hits[0].key.toUpperCase()} (${String(hit.hits[0].file).replace(/^batch\d+__/, "")}), but its details have not been read yet, so I can't state a value from it.`;

/** H327 answer-side check: the answer text claims the DOCUMENT itself is absent ("No work order WO-70412 on file"), not just a field ("No date on file for EF-372"). */
export function claimsDocumentAbsent(text, keys) {
  const t = String(text ?? ""); if (!ABSENT_RE.test(t)) return false;
  for (const sent of t.split(/(?<=[.!?])\s+/)) {
    if (!ABSENT_RE.test(sent)) continue;
    const m = /\bon file\b|\bnot stored\b|\bfound\b|\bno stored document\b/i.exec(sent); const cut = m ? m.index : sent.length;
    const before = sent.slice(0, cut);
    for (const x of before.matchAll(/(?<![A-Za-z0-9])[A-Za-z]{1,6}[-_#]?\d[A-Za-z0-9-]{2,}/g)) if (keys.includes(alnum(x[0]))) return true;
  }
  return false;
}
/** H327 main entry: pages = every stored page/filename (read or unread). Returns replacement answer text, or null to leave the answer untouched. */
export function auditAbsenceAnswer(pages, question, answerText) {
  const a = absenceAudit(pages, question); if (!a.hit) return null;
  if (!claimsDocumentAbsent(answerText, a.keys)) return null;
  return pointerText(a, question);
}
