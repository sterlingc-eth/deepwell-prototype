/**
 * R2 gate (loop 4): sentence-level guards that sit on top of the claim checks in gate.js. PURE; no DB, no model.
 *
 *  suffix      a name followed by Jr / Sr / III / DDS / MD / Esq / PhD ... : the SAME suffix must follow that surname on the page
 *  role        a person / company bound to a role outside the mapped list (director, parent, emergency contact, pickup, shipper, consignee ...)
 *  date label  a date bound to a label word that, on the page, sits on a DIFFERENT date's line
 *  marker      checked / unchecked box, signed / unsigned, void / cancelled / superseded / valid
 *  reference   Article / Section / Exhibit ... references must be printed on the page
 *  qualifier   "before tax", "after discount", "excluding", "plus tax": the page must print the same qualifier for that amount
 *  pages       a cited page must contain the figures claimed from it (a wrong page number is corrected or dropped)
 *
 * Every guard only fails on POSITIVE evidence that the page says something else (it never fails on something the page is silent about, except
 * invented suffixes, references and void / cancelled claims, which must be printed). gate.js hands in the few helpers it needs through initGate3().
 */
import { pageDates, payEvidence, unpaidEvidence } from './gate2.js';
let D = null;
export const initGate3 = (deps) => { D = deps; };
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fixQ = (s) => String(s ?? '').replace(/[‘’]/g, "'");
const ne = (a) => a.length > 0;

/* ------------------------------------------------------------------ suffixes / credentials */
const SUF_RE = /\b([A-Z][A-Za-z'-]{1,})(?:\s*,\s*|\s+)(Jr|Sr|III|II|IV|Esq|MD|DDS|DMD|DVM|PhD|CPA|JD|RN|MBA)\b\.?/g;
const SUF_ALT = 'Jr|Sr|III|II|IV|Esq|MD|DDS|DMD|DVM|PhD|CPA|JD|RN|MBA';
function suffixGuard(sent, hays) {
  for (const m of sent.matchAll(SUF_RE)) {
    const sur = m[1]; const suf = m[2];
    if (/^(?:Dr|Mr|Mrs|Ms)$/.test(sur)) continue;
    const re = new RegExp(`\\b${esc(sur)}\\s*,?\\s*${suf === 'Esq' ? 'Esq(?:uire)?' : suf}\\b`, 'i');
    const reSur = new RegExp(`\\b${esc(sur)}\\b`, 'i');
    const seen = hays.filter((h) => reSur.test(h));
    if (!seen.length) continue; // the name itself is checked elsewhere
    if (!seen.some((h) => re.test(h.replace(/\./g, '')))) return { kind: 'name', claim: `${sur} ${suf}` };
  }
  return null;
}

/* ------------------------------------------------------------------ roles outside the mapped list */
const ROLES = [
  ['parent', /\bparents?\b/i], ['guardian', /\bguardians?\b/i], ['director', /\bdirectors?\b/i], ['emergency contact', /\bemergency\s+contacts?\b/i],
  ['pickup', /\bpick-?\s?ups?\b|\bauthori[sz]ed\s+pick/i], ['shipper', /\bshippers?\b/i], ['consignee', /\bconsignees?\b/i], ['contractor', /\bcontractors?\b/i],
  ['beneficiary', /\bbeneficiar(?:y|ies)\b/i], ['borrower', /\bborrowers?\b/i], ['lender', /\blenders?\b/i], ['insured', /\binsured\b/i], ['claimant', /\bclaimants?\b/i],
  ['owner', /\bowners?\b/i], ['manager', /\bmanagers?\b/i],
];
const ROLE_FOR_ASK = new RegExp(`\\b(?:authori[sz]ed\\s+pick-?\\s?ups?|emergency\\s+contacts?|pick-?\\s?ups?|parents?|guardians?|directors?|shippers?|consignees?|contractors?|beneficiar(?:y|ies)|borrowers?|lenders?|insured|claimants?|owners?|managers?)\\b`, 'gi');
const NAME_RE = /(?:(?:Dr|Mr|Mrs|Ms|Mx)\.\s+)?[A-Z][A-Za-z'-]+(?:\s+(?:[A-Z]\.|[A-Z][A-Za-z'-]+|&))*/y;
const NAME_STOP = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'he', 'she', 'they', 'there', 'yes', 'no', 'not', 'on', 'by', 'in']);
const TITLE_W = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'jr', 'sr', 'ii', 'iii', 'iv', 'esq', 'md', 'dds', 'dmd', 'dvm', 'phd', 'cpa', 'jd', 'rn', 'mba']);
const toks = (name) => fixQ(name).toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !TITLE_W.has(w));
function nameAfter(sent, from) {
  let rest = sent.slice(from).replace(/^(?:'s)?\s*(?:name\s+)?(?:(?:is|was|are|were|=|:|-|–|,|as|being)\s*)*(?:(?:the|a|an|our|his|her)\s+)?(?:named\s+)?/i, '');
  const lead = sent.length - rest.length;
  void lead;
  NAME_RE.lastIndex = 0; const m = NAME_RE.exec(rest); if (!m) return null;
  const first = m[0].split(/\s+/)[0].toLowerCase(); if (NAME_STOP.has(first)) return null;
  return m[0].replace(/\s+&$/, '');
}
function nameBefore(sent, to) {
  const pre = sent.slice(0, to).replace(/\s+(?:is|was|are|were|serves\s+as|acts\s+as|as)\s+(?:the|a|an|our)?\s*$/i, (x) => `\u0001${x}`);
  const i = pre.indexOf('\u0001'); if (i < 0) return null;
  const head = pre.slice(0, i);
  const m = /((?:(?:Dr|Mr|Mrs|Ms|Mx)\.\s+)?[A-Z][A-Za-z'-]+(?:\s+(?:[A-Z]\.|[A-Z][A-Za-z'-]+|&))*)\s*$/.exec(head);
  if (!m) return null; const first = m[1].split(/\s+/)[0].toLowerCase(); return NAME_STOP.has(first) ? null : m[1];
}
function roleGuard(sent, hays) {
  for (const m of sent.matchAll(ROLE_FOR_ASK)) {
    const word = m[0]; const role = ROLES.find(([, re]) => re.test(word)); if (!role) continue;
    const names = [nameAfter(sent, m.index + word.length), nameBefore(sent, m.index)].filter(Boolean);
    for (const name of names) {
      const t = toks(name); if (!t.length) continue;
      const withRole = hays.filter((h) => role[1].test(h));
      if (!withRole.length) continue; // the page does not use this word: the mapped-role checks decide
      const ok = withRole.some((h) => {
        const lines = h.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!role[1].test(lines[i])) continue;
          const win = fixQ(`${lines[i]}${/:\s*$/.test(lines[i]) || !/[A-Za-z]{2}.*[A-Za-z]{2}/.test(lines[i].replace(role[1], '')) ? ` ${lines[i + 1] ?? ''}` : ''}`).toLowerCase();
          if (t.every((w) => win.includes(w))) return true;
        }
        return false;
      });
      if (!ok) return { kind: 'name', claim: `${role[0]}: ${name}`.slice(0, 60) };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ dates bound to the wrong label */
const LAB_STOP = new Set(['the', 'and', 'for', 'was', 'were', 'are', 'its', 'has', 'have', 'been', 'that', 'this', 'with', 'from', 'date', 'dated', 'scheduled', 'set', 'listed', 'shown', 'service', 'visit', 'invoice', 'document', 'estimate', 'agreement', 'contract', 'total', 'amount', 'also', 'currently', 'only', 'about', 'around', 'upon', 'than', 'then', 'which', 'when', 'where', 'what']);
const sameD = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;
function dateLabelGuard(sent, hays) {
  if (!D) return null;
  const cands = D.dateCandidates(sent); if (!cands.length) return null;
  for (const s of cands) {
    const p = D.parseDate(s); if (!p?.y || !p.m || !p.d) continue;
    const at = sent.indexOf(s); if (at < 0) continue;
    const lead = sent.slice(0, at).split(/[.;:!?,]\s|\b(?:and|but|while)\b/i).pop().toLowerCase().replace(/[^a-z\s-]/g, ' ');
    const words = lead.split(/\s+/).filter((w) => w.length >= 4 && !LAB_STOP.has(w)).slice(-3);
    if (!words.length) continue;
    const stems = words.map((w) => new RegExp(`\\b${esc(w.slice(0, 5))}`, 'i'));
    const pds = hays.map((h) => pageDates(h));
    if (!pds.some((arr) => arr.some((x) => sameD(x, p)))) continue; // the date itself is checked elsewhere
    // some hay where the date is on a line that carries one of the label words (or the line above when that one is label-only): bound
    let bound = false; let elsewhere = false;
    hays.forEach((h, k) => {
      const lines = h.split('\n');
      for (const x of pds[k]) {
        const win = `${x.ln}${x.i > 0 && !/\d/.test(lines[x.i - 1] ?? '') ? `\n${lines[x.i - 1]}` : ''}`;
        const isThis = sameD(x, p);
        const hit = stems.some((re) => re.test(win));
        if (isThis && hit) bound = true; else if (!isThis && hit) elsewhere = true;
      }
    });
    if (!bound && elsewhere) return { kind: 'date', claim: s };
  }
  return null;
}

/* ------------------------------------------------------------------ markers: checkbox / signature / void / cancelled / superseded */
const UNCHK = /\[\s\]|☐|\(\s\)|\bunchecked\b|\bnot\s+checked\b|\bunsigned\b|\bnot\s+signed\b|_{3,}\s*(?:\(\s*\))?\s*$|\bpending\s+signature\b|\bawaiting\s+signature\b|\bdeclined\b|\brefused\b/i;
const CHK = /\[\s*[xX✓✔]\s*\]|☒|☑|✓|✔|\(\s*[xX]\s*\)|\bsigned\b(?!\s*:?\s*_)|\/s\/|\bchecked\b|\bsignature\s*:\s*[A-Z][a-z]+/;
const SUBJ_STOP = new Set(['the', 'a', 'an', 'yes', 'no', 'that', 'box', 'and', 'it', 'this', 'also', 'has', 'have', 'had', 'been', 'was', 'were', 'now', 'already', 'still', 'is', 'are', 'of', 'to', 'for', 'on', 'in', 'does', 'did', 'not', 'form', 'item', 'section', 'option', 'line', 'document', 'agreement', 'contract', 'record', 'file', 'invoice', 'then']);
const lineState = (ln) => (UNCHK.test(ln) ? 'u' : CHK.test(ln) ? 'c' : null);
function subjectLines(hays, subj, signish) {
  const stems = subj.map((w) => new RegExp(`\\b${esc(w.slice(0, 5))}`, 'i')); const out = [];
  for (const h of hays) for (const ln of h.split('\n')) {
    if (!stems.every((re) => re.test(ln))) continue;
    if (signish && !/sign/i.test(ln)) continue;
    const st = lineState(ln); if (st) out.push(st);
  }
  return out;
}
const subjOf = (txt) => txt.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !SUBJ_STOP.has(w)).slice(-3);
const POS_RE = /((?:[A-Za-z][A-Za-z-]*\s+){1,5}?)(?:box\s+)?(?:is|was|has\s+been|have\s+been|are|were|got)\s+((?:not\s+)?)(checked|ticked|selected|marked|opted\s+in|authori[sz]ed|signed|initialed|initialled|completed)\b/gi;
const SIGNED_RE = /((?:[A-Za-z][A-Za-z-]*\s+){1,3}?)((?:did\s+not|didn't|has\s+not|hasn't|have\s+not|never|will\s+not)\s+)?(?:has\s+|have\s+|had\s+)?(signed|sign)\b(?!\s+(?:by|off))/gi;
const UNSIGNED_RE = /((?:[A-Za-z][A-Za-z-]*\s+){1,5}?)(?:is|was|remains|are)\s+(unsigned|not\s+signed|not\s+checked|unchecked)\b/gi;
const CONSENT_RE = /\b(did\s+not|didn't|does\s+not|doesn't|has\s+not|hasn't|never|refused\s+to|declined\s+to|(?:also\s+)?(?:did|does|has))\s+(?:been\s+)?(consent|agree|authori[sz]e|release|opt|accept)\w*\s*(?:to\s+|for\s+)?([A-Za-z-]+(?:\s+[A-Za-z-]+){0,2})?/gi;
const VOIDW = /\b(void(?:ed)?|cancell?ed|superseded|rescinded|revoked)\b/gi;
const VOIDSTEM = { void: /\bvoid/i, cancel: /\bcancel/i, supersed: /\bsupersed/i, rescind: /\brescind/i, revok: /\brevok/i };
const stemOfVoid = (w) => (/^void/i.test(w) ? 'void' : /^cancel/i.test(w) ? 'cancel' : /^supersed/i.test(w) ? 'supersed' : /^rescind/i.test(w) ? 'rescind' : 'revok');
const VALIDW = /\b(?:is|was|remains|still|currently)\s+(?:currently\s+|still\s+)?(valid|active|in\s+effect|in\s+force|binding|final|approved)\b/i;
function markerGuard(sent, hays) {
  const low = fixQ(sent);
  for (const m of low.matchAll(POS_RE)) {
    const subj = subjOf(m[1]); if (!subj.length) continue; const neg = Boolean(m[2]);
    const sig = /^signed$/i.test(m[3]); const st = subjectLines(hays, subj, sig && subj.some((w) => /signature|sign/.test(w)));
    if (!ne(st)) continue;
    if (!neg && st.every((x) => x === 'u')) return { kind: 'stat', claim: m[0].trim().slice(0, 60) };
    if (neg && st.every((x) => x === 'c')) return { kind: 'stat', claim: m[0].trim().slice(0, 60) };
  }
  for (const m of low.matchAll(SIGNED_RE)) {
    const subj = subjOf(m[1]); if (!subj.length) continue;
    const st = subjectLines(hays, subj, true); if (!ne(st)) continue;
    const neg = Boolean(m[2]);
    if (!neg && st.every((x) => x === 'u')) return { kind: 'stat', claim: m[0].trim().slice(0, 60) };
    if (neg && st.every((x) => x === 'c')) return { kind: 'stat', claim: m[0].trim().slice(0, 60) };
  }
  for (const m of low.matchAll(UNSIGNED_RE)) {
    const subj = subjOf(m[1]); if (!subj.length) continue;
    const st = subjectLines(hays, subj, /sign/i.test(m[2])); if (ne(st) && st.every((x) => x === 'c')) return { kind: 'stat', claim: m[0].trim().slice(0, 60) };
  }
  for (const m of low.matchAll(CONSENT_RE)) {
    const verb = m[2].toLowerCase(); const neg = /not|n't|never|refused|declined/i.test(m[1]);
    const obj = subjOf(m[3] ?? '');
    const re = new RegExp(`\\b${esc(verb.slice(0, 5))}`, 'i'); const st = [];
    for (const h of hays) for (const ln of h.split('\n')) { if (!re.test(ln)) continue; if (obj.length && !obj.every((w) => new RegExp(`\\b${esc(w.slice(0, 5))}`, 'i').test(ln))) continue; const s = lineState(ln); if (s) st.push(s); }
    if (ne(st) && neg && st.every((x) => x === 'c')) return { kind: 'stat', claim: m[0].trim().slice(0, 60) };
  }
  // void / cancelled / superseded
  const docVoid = hays.some((h) => /\b(?:void|voided|cancell?ed|superseded|rescinded|revoked)\b/i.test(h));
  for (const m of low.matchAll(VOIDW)) {
    const pre = low.slice(Math.max(0, m.index - 22), m.index);
    const neg = /\b(?:not|never|isn't|wasn't|hasn't|haven't|hasn't\s+been|no|un)\s*(?:yet\s+|been\s+)?$/i.test(pre);
    const stem = stemOfVoid(m[1]); const has = hays.some((h) => VOIDSTEM[stem].test(h));
    if (!neg && !has) return { kind: 'stat', claim: m[0] };
    if (neg && has) return { kind: 'stat', claim: `${pre.trim().split(/\s+/).pop()} ${m[0]}` };
  }
  if (docVoid) { const v = VALIDW.exec(low); if (v && !VOIDW.test(low)) { VOIDW.lastIndex = 0; return { kind: 'stat', claim: v[0].trim() }; } VOIDW.lastIndex = 0; }
  return null;
}

/* ------------------------------------------------------------------ Article / Section / Exhibit references */
const REF_RE = /\b(Article|Section|Exhibit|Schedule|Appendix|Clause|Paragraph|Addendum|Attachment|Annex)\s+((?:[IVXLC]{1,6}|\d+(?:\.\d+)*|[A-Z])(?![A-Za-z0-9]))/g;
function refGuard(sent, hays) {
  for (const m of sent.matchAll(REF_RE)) {
    const re = new RegExp(`\\b${m[1]}s?\\s*[#.-]?\\s*${esc(m[2])}(?![A-Za-z0-9])`, 'i');
    if (!hays.some((h) => re.test(h) || (/^Section$/i.test(m[1]) && new RegExp(`§\\s*${esc(m[2])}(?![A-Za-z0-9])`).test(h)))) return { kind: 'id', claim: m[0] };
  }
  return null;
}

/* ------------------------------------------------------------------ qualifiers on amounts */
const Q_RE = /\b(before|after|excluding|exclusive\s+of|including|inclusive\s+of|incl\.?|excl\.?|plus|without|pre|post)[-\s]*(?:the\s+|any\s+|all\s+)?(sales\s+tax|taxes|tax|gst|vat|discounts?|insurance|fees?|shipping|freight|deposit|credit|tip|gratuity|surcharge)\b|\+\s*(tax|taxes)\b/gi;
const qGroup = (w) => (/^(?:before|excl|excluding|exclusive|plus|without|pre|\+)/i.test(w) ? 'x' : 'i');
const qNoun = (n) => (/tax|gst|vat/i.test(n) ? 'tax' : /discount/i.test(n) ? 'discount' : n.toLowerCase().replace(/s$/, ''));
const MONEY_S = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
function qualifierGuard(sent, hays) {
  const money = [...sent.matchAll(MONEY_S)].map((m) => ({ at: m.index, v: D.canonNumber(m[1]) }));
  if (!money.length) return null;
  for (const q of sent.matchAll(Q_RE)) {
    const grp = qGroup(q[1] ?? '+'); const noun = qNoun(q[2] ?? q[3]);
    let best = null; for (const mo of money) { const dist = Math.min(Math.abs(mo.at - q.index), Math.abs(mo.at - (q.index + q[0].length))); if (!best || dist < best.dist) best = { ...mo, dist }; }
    if (!best || best.dist > 60) continue;
    let sameG = false; let oppG = false; let amountLines = 0; let totalLike = false; let subLike = false; let nounOnPage = false;
    for (const h of hays) {
      const lines = h.split('\n');
      lines.forEach((ln, i) => {
        if (new RegExp(`\\b${noun === 'tax' ? '(?:tax|gst|vat)' : esc(noun)}`, 'i').test(ln)) nounOnPage = true;
        if (!D.moneyNumbersIn(ln).has(best.v)) return;
        amountLines++;
        const win = `${ln}${i > 0 && !/\d/.test(lines[i - 1]) ? ` ${lines[i - 1]}` : ''}`;
        let had = false;
        for (const pq of win.matchAll(Q_RE)) { if (qNoun(pq[2] ?? pq[3]) !== noun) continue; had = true; if (qGroup(pq[1] ?? '+') === grp) sameG = true; else oppG = true; }
        if (!had) { if (/sub-?total|pre-?tax|before\s+tax|net\s+amount/i.test(win)) subLike = true; else if (/\b(?:total|amount\s+due|balance\s+due|grand)\b/i.test(win)) totalLike = true; }
      });
    }
    if (!amountLines) continue; // the amount itself is checked elsewhere
    if (sameG) continue;
    if (oppG) return { kind: 'money', claim: `${q[0]}`.slice(0, 60) };
    if (grp === 'x' && noun === 'tax' && subLike) continue;
    if (grp === 'i' && totalLike && nounOnPage) continue;
    if (grp === 'x' && nounOnPage && !totalLike) continue;
    return { kind: 'money', claim: `${q[0]}`.slice(0, 60) };
  }
  return null;
}

/** all the sentence guards; returns the first failure {kind, claim} or null */

/* ------------------------------------------------------------------ loop 1: identifiers, polarity, antonyms, bounds, pairs, units, status, initials, topics */
const hmemo = new Map();
const STOPW = new Set('the and for was were are its has have had been that this with from also they their there them then than will would can may could should does did not non never without cannot any all each every some into onto over under about after before while which when where what who whom whose here your you our his her him she out off per via'.split(' '));
const NEG_RE = /\b(?:not|no|never|without|cannot|none|neither|nor|unless)\b(?!\s*[:.#]|\s+\d)|n't\b|\bnon-?[a-z]/i;
const COND_RE = /\b(?:if|unless|only\s+when|provided\s+that|except)\b/i;
const CONDP = new Set(['void', 'valid', 'refun', 'cover', 'waive', 'bindi', 'effec', 'null']);
const stemOf = (w) => { let x = w.toLowerCase(); if (x.length > 5) x = x.replace(/(?:ing|ed|es|s|d)$/, ''); return x.slice(0, 5); };
function analyse(text) {
  const t = fixQ(text); const stems = new Set();
  const neg = NEG_RE.test(t.replace(/\bno\.(?=\s*\d)/gi, ''));
  for (const w of t.toLowerCase().replace(/non-?(?=[a-z])/g, ' ').match(/[a-z]{4,}/g) ?? []) { if (STOPW.has(w)) continue; const st = stemOf(w); if (st === 'expir' || st === 'activ') continue; stems.add(st); }
  return { stems, neg: neg || /:\s*\$?0(?:\.00)?\s*$|\bnone\b|\bn\/a\b/i.test(t), cond: COND_RE.test(t) };
}
function hinfo(h) {
  let v = hmemo.get(h); if (v) return v;
  if (hmemo.size > 60) hmemo.clear();
  const lines = h.split('\n'); const info = lines.map((ln) => (ln.length > 400 ? null : analyse(ln)));
  v = { lines, info, hasPol: info.some((x) => x && (x.neg || x.cond)), hasMod: lines.some((l) => MOD_ANY.test(l)) };
  hmemo.set(h, v); return v;
}
const MAXM = /\b(?:up\s+to|at\s+most|maximum|max\.?|no\s+more\s+than|not\s+(?:to\s+)?exceed|capped\s+at)\b/gi;
const MINM = /\b(?:at\s+least|minimum|min\.?|no\s+less\s+than|starting\s+at)\b/gi;
const MOD_ANY = /\b(?:up\s+to|at\s+most|maximum|no\s+more\s+than|not\s+(?:to\s+)?exceed|capped\s+at|at\s+least|minimum|no\s+less\s+than|starting\s+at)\b/i;
function polarityGuard(sent, hays) {
  const S = analyse(sent); if (S.stems.size < 2) return null;
  const need = Math.max(2, Math.ceil(S.stems.size * 0.75));
  const sPred = [...S.stems].filter((x) => CONDP.has(x));
  let matched = false;
  for (const h of hays) {
    const { info } = hinfo(h);
    for (const L of info) {
      if (!L) continue; let c = 0; for (const x of S.stems) if (L.stems.has(x)) c++;
      if (c < need) continue; matched = true;
      const condRel = sPred.some((x) => L.stems.has(x));
      if (L.neg === S.neg && (!condRel || L.cond === S.cond)) return null;
    }
  }
  return matched ? { kind: 'stat', claim: sent.slice(0, 60) } : null;
}
const ANT = [['indoors?', 'outdoors?'], ['inside', 'outside'], ['increas\\w*', 'decreas\\w*'], ['raise[sd]?|raising', 'lower(?:s|ed|ing)?'], ['above', 'below'], ['allowed', 'prohibited'], ['permitted', 'prohibited'], ['mandatory|required', 'optional'], ['male', 'female'], ['intramuscular|\\bIM', 'subcutaneous|\\bSQ|\\bSC'], ['boy', 'girl'], ['ascending', 'descending']].map(([a, b]) => [new RegExp(`\\b(?:${a})\\b`, 'i'), new RegExp(`\\b(?:${b})\\b`, 'i')]);
const ANT_CUE = /indoor|outdoor|inside|outside|increas|decreas|raise|lower|above|below|allowed|prohibited|permitted|mandatory|required|optional|male|boy|girl|intramuscular|subcutaneous|\bIM\b|\bSQ\b|\bSC\b|ascending|descending/i;
function antonymGuard(sent, hays) {
  const sw = new Set(analyse(sent).stems);
  for (const [A, B] of ANT) for (const [X, Y] of [[A, B], [B, A]]) {
    if (!X.test(sent) || Y.test(sent)) continue;
    const hasX = hays.some((h) => X.test(h)); const hasY = hays.some((h) => Y.test(h));
    if (!hasY) continue;
    if (!hasX) return { kind: 'stat', claim: (sent.match(X) ?? [''])[0] };
    // both on the page: the lines that share a content word with the sentence decide
    let sawY = false; let sawX = false;
    for (const h of hays) { const { lines, info } = hinfo(h); lines.forEach((ln, i) => { const L = info[i]; if (!L) return; let c = 0; for (const x of sw) if (!X.test(x) && !Y.test(x) && L.stems.has(x)) c++; if (!c) return; if (X.test(ln)) sawX = true; else if (Y.test(ln)) sawY = true; }); }
    if (sawY && !sawX) return { kind: 'stat', claim: (sent.match(X) ?? [''])[0] };
  }
  return null;
}
function modifierGuard(sent, hays) {
  for (const m of sent.matchAll(MONEY_S)) {
    const pre = sent.slice(Math.max(0, m.index - 28), m.index);
    let cls = null; let at = -1;
    for (const [re, c] of [[MAXM, 'max'], [MINM, 'min']]) { re.lastIndex = 0; for (const x of pre.matchAll(re)) if (x.index > at) { at = x.index; cls = c; } }
    const v = D.canonNumber(m[1]); const lines = [];
    for (const h of hays) for (const ln of hinfo(h).lines) if (ln.length < 400 && D.moneyNumbersIn(ln).has(v)) lines.push(ln);
    if (!lines.length) continue;
    const cl = (ln) => { const o = []; for (const [re, c] of [[MAXM, 'max'], [MINM, 'min']]) { re.lastIndex = 0; if (re.test(ln)) o.push(c); } return o; };
    if (cls) { if (!lines.some((ln) => cl(ln).includes(cls))) return { kind: 'money', claim: `${cls === 'max' ? 'up to' : 'at least'} ${m[0]}` }; }
    else if (lines.every((ln) => cl(ln).length) && lines.some((ln) => { const a = analyse(ln); const b = analyse(sent); return [...a.stems].some((x) => b.stems.has(x)); })) return { kind: 'money', claim: m[0] };
  }
  return null;
}
const FROMTO = /\bfrom\s+(\$?\d[\d,]*(?:\.\d+)?)\s+to\s+(\$?\d[\d,]*(?:\.\d+)?)/gi;
function fromToGuard(sent, hays) {
  for (const m of sent.matchAll(FROMTO)) {
    const a = D.canonNumber(m[1].replace('$', '')); const b = D.canonNumber(m[2].replace('$', '')); let seen = false; let ordered = false;
    for (const h of hays) for (const ln of hinfo(h).lines) {
      if (ln.length > 400) continue;
      const pos = new Map(); for (const x of ln.matchAll(/\$?(\d[\d,]*(?:\.\d+)?)/g)) { const c = D.canonNumber(x[1]); if (!pos.has(c)) pos.set(c, x.index); }
      if (!pos.has(a) || !pos.has(b)) continue; seen = true; if (pos.get(a) < pos.get(b)) ordered = true;
    }
    if (seen && !ordered) return { kind: 'money', claim: m[0] };
  }
  return null;
}
/* quantity + unit families, bound to the label of their own page line */
const UFAM = [['sqft', /^(?:sq\.?\s?-?ft|sq\.?\s?-?feet|square\s+f(?:ee|oo)t|sqft|sf)\b/i], ['lft', /^(?:linear\s+f(?:ee|oo)t|lin\.?\s?ft|lf|linear\s+ft)\b/i], ['ft', /^(?:f(?:ee|oo)t|ft)\b/i], ['lb', /^(?:lbs?|pounds?)\b/i], ['oz', /^(?:oz|ounces?)\b/i],
  ['kg', /^(?:kgs?|kilograms?)\b/i], ['ml', /^(?:ml|milliliters?)\b/i], ['mg', /^(?:mg|milligrams?)\b/i], ['gal', /^(?:gal|gallons?)\b/i], ['year', /^(?:years?|yrs?)\b/i], ['month', /^(?:months?|mos?)\b/i], ['week', /^(?:weeks?|wks?)\b/i], ['day', /^(?:days?)\b/i], ['hour', /^(?:hours?|hrs?)\b/i], ['pct', /^%/]];
const NUMU = /(?<![\w.$,/#-])(\d+(?:\.\d+)?)\s*(%|[A-Za-z][A-Za-z.]*(?:\s+(?:ft|feet|foot))?)/g;
const ufam = (rest) => { for (const [k, re] of UFAM) if (re.test(rest)) return k; return null; };
const GENERIC_LAB = new Set(['total', 'amount', 'price', 'cost', 'balance', 'subtotal', 'invoice', 'quote', 'estimate', 'sum', 'number', 'item', 'there', 'document', 'record', 'order', 'lease', 'policy', 'contract', 'agreement', 'certificate', 'permit', 'warranty', 'coverage']);
const TIMEW = /\b(?:due\s+)?(?:on|at|upon)\s+(signing|completion|delivery|approval|acceptance|closing|execution)\b/i;
function figuresOf(seg) {
  const out = [];
  for (const m of seg.matchAll(MONEY_S)) out.push({ kind: 'money', v: D.canonNumber(m[1]), start: m.index, end: m.index + m[0].length, unit: null });
  for (const m of seg.matchAll(NUMU)) { if (seg[m.index - 1] === '$') continue; const f = ufam(m[2]); if (!f) continue; out.push({ kind: 'qty', v: D.canonNumber(m[1]), start: m.index, end: m.index + m[0].length, unit: f }); }
  return out;
}
function lineHasFigure(ln, f) {
  if (f.kind === 'money') return D.moneyNumbersIn(ln).has(f.v);
  for (const m of ln.matchAll(NUMU)) if (D.canonNumber(m[1]) === f.v && ufam(m[2]) === f.unit) return true;
  return false;
}
function figureLabelGuard(sent, hays) {
  const segs = sent.split(/;|,(?!\d)|\band\b|\bbut\b/i);
  for (const seg0 of segs) {
    const seg = seg0.trim(); if (!/\d/.test(seg)) continue;
    const figs = figuresOf(seg); if (figs.length !== 1) continue; const f = figs[0];
    // unit swap with equal number elsewhere: some page line holds the number (with other units) but none with this unit
    if (f.kind === 'qty') {
      let numLines = 0; let unitLines = 0; let otherUnit = false;
      for (const h of hays) for (const ln of hinfo(h).lines) { if (ln.length > 400) continue; for (const m of ln.matchAll(NUMU)) { if (D.canonNumber(m[1]) !== f.v) continue; const u = ufam(m[2]); if (!u) continue; numLines++; if (u === f.unit) unitLines++; else if (!(u === 'ft' || f.unit === 'ft')) otherUnit = true; } }
      if (numLines && !unitLines && otherUnit) return { kind: 'qty', claim: seg.slice(f.start, f.end) };
    }
    const labels = [];
    const after = seg.slice(f.end).replace(/^\s*(?:per\s+\w+|each)\b/i, '');
    const am = /^\s+([A-Za-z][A-Za-z-]{3,})\b/.exec(after);
    if (am && !STOPW.has(am[1].toLowerCase()) && !/^(?:from|due|plus|before|after|including|excluding)$/i.test(am[1])) labels.push(am[1]);
    const tm = TIMEW.exec(seg.slice(f.end)); if (tm) labels.push(tm[1]);
    const bm = /^\s*(?:the|a|an)?\s*((?:[A-Za-z-]{3,}\s+){0,1}[A-Za-z-]{3,})\s+(?:is|are|was|were)\s+(?:about\s+|only\s+|just\s+)?$/i.exec(seg.slice(0, f.start));
    if (bm) for (const w of bm[1].split(/\s+/)) labels.push(w);
    const stems = [...new Set(labels.map((w) => w.toLowerCase()).filter((w) => !STOPW.has(w) && !GENERIC_LAB.has(w) && w.length >= 3).map((w) => stemOf(w)))];
    if (!stems.length) continue;
    const figLines = []; const digitLines = [];
    for (const h of hays) { const { lines } = hinfo(h); lines.forEach((ln, i) => { if (ln.length > 400) return; const win = `${ln}${i > 0 && !/\d/.test(lines[i - 1]) ? ` ${lines[i - 1]}` : ''}`.toLowerCase(); if (lineHasFigure(ln, f)) figLines.push(win); else if (/\d/.test(ln)) digitLines.push(win); }); }
    if (!figLines.length) continue;
    const onDigit = stems.filter((x) => digitLines.some((w) => w.includes(x)) || figLines.some((w) => w.includes(x)));
    if (!onDigit.length) continue;
    if (!figLines.some((w) => onDigit.every((x) => w.includes(x)))) return { kind: f.kind, claim: seg.slice(0, 60) };
  }
  return null;
}
/* status words, credits, amounts owed on a paid page */
const LEX = [['delivered', /\bdelivered\b/i], ['shipped', /\bshipped\b/i], ['transit', /\bin\s+transit\b/i], ['pending', /\bpending\b/i], ['processing', /\bprocessing\b/i], ['returned', /\breturned\b/i], ['backordered', /\bback-?ordered\b/i], ['completed', /\bcompleted?\b/i], ['approved', /\bapproved\b/i], ['declined', /\b(?:declined|denied)\b/i]];
const LEX_CUE = /deliver|shipped|transit|pending|processing|returned|back-?order|complete|approved|declined|denied/i;
function statusGuard(sent, hays, ctx = {}) {
  for (const [k, re] of LEX) {
    const m = re.exec(sent); if (!m) continue;
    if (/\b(?:not|never|un|isn't|wasn't|hasn't)\s*(?:yet\s+|been\s+)?$/i.test(sent.slice(Math.max(0, m.index - 16), m.index))) continue;
    if (hays.some((h) => re.test(h))) continue;
    if (hays.some((h) => LEX.some(([k2, r2]) => k2 !== k && r2.test(h)))) return { kind: 'stat', claim: m[0] };
  }
  if (/\b(?:owes?|owed|outstanding|still\s+due|unpaid)\b/i.test(sent) && /\$\s?(?!0(?:\.0+)?(?![\d,]))[1-9\d]/.test(sent) && hays.every((h) => payEvidence(h) && !unpaidEvidence(h)) && !(ctx.storedStates ?? []).some((st) => st === 'unpaid' || st === 'partial')) return { kind: 'stat', claim: 'owes' }; // R5: the stored payment status outranks what the page text says about itself
  if (/\bcredit/i.test(sent) && /\b(?:added|adds|increas\w+)\b/i.test(sent)) {
    const cl = hays.flatMap((h) => h.split('\n').filter((l) => /\bcredit/i.test(l)));
    if (cl.some((l) => /-\s?\$|\(\s?\$|applied|deduct|subtract|\bless\b|reduc/i.test(l)) && !cl.some((l) => /\badded\b|\badds\b/i.test(l))) return { kind: 'money', claim: 'credit added' };
  }
  const hm = /\b(half|a\s+quarter|quarter|one[- ]third|a\s+third|two[- ]thirds)\b[^.]{0,30}\b(?:on|at|upon)\s+\w+/i.exec(sent);
  if (hm) { const w = hm[1].toLowerCase(); const pct = /half/.test(w) ? '50' : /quarter/.test(w) ? '25' : /two/.test(w) ? '66' : '33'; const re = new RegExp(`\\b${pct}(?:\\.\\d+)?\\s?%|\\b${w.replace(/^a\s+/, '').replace(/[- ]/, '[- ]')}\\b`, 'i'); if (!hays.some((h) => re.test(h))) return { kind: 'qty', claim: hm[0].slice(0, 40) }; }
  return null;
}
const INIT_RE = /\b([A-Z][a-z]{2,})\s+([A-Z])\.?\s+([A-Z][a-z'-]{2,})\b/g;
function initialGuard(sent, hays) {
  for (const m of sent.matchAll(INIT_RE)) {
    const re = new RegExp(`\\b${esc(m[1])}\\s+(?:([A-Z])\\.?\\s+)?${esc(m[3])}\\b`, 'g'); let seen = false; let ok = false;
    for (const h of hays) for (const x of h.matchAll(re)) { seen = true; if (x[1] === m[2]) ok = true; }
    if (seen && !ok) return { kind: 'name', claim: m[0] };
  }
  return null;
}
const TOPIC_RE = /\b(matter|type|purpose|reason|category|status)\s+(?:is|was|:)\s+(?:an?\s+|the\s+)?([A-Za-z][A-Za-z -]{2,40}?)(?=[.,;!?]|$|\s+and\b|\s+but\b)/gi;
function topicGuard(sent, hays) {
  for (const m of sent.matchAll(TOPIC_RE)) {
    const label = m[1].toLowerCase(); const want = (m[2].toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOPW.has(w)).map(stemOf); if (!want.length) continue;
    const lre = new RegExp(`^\\s*[^:]{0,30}\\b${label}\\b[^:]{0,15}:\\s*(.+)$`, 'i'); const vals = [];
    for (const h of hays) for (const ln of hinfo(h).lines) { const x = lre.exec(ln); if (x) vals.push((x[1].toLowerCase().match(/[a-z]{3,}/g) ?? []).map(stemOf)); }
    if (!vals.length) continue;
    if (!vals.some((v) => v.some((w) => want.includes(w)))) return { kind: 'stat', claim: m[0].slice(0, 60) };
  }
  return null;
}
const ID_TOK = /(?<![\w$.,/:#-])((?:[A-Z]{2,5}[ -]?)?)(\d(?:\d|[ -](?=\d)){5,}\d)(?![\w]|[.,]\d)/g;
function idGuard(sent, hays) {
  for (const m of sent.matchAll(ID_TOK)) {
    const digits = m[2].replace(/\D/g, ''); const pre = m[1].replace(/[^A-Za-z]/g, '').toLowerCase();
    if (pre ? digits.length < 6 : digits.length < 9) continue;
    if (/^\d{3}[ -]\d{3}[ -]\d{4}$/.test(m[2]) || /^\d{1,4}-\d{1,2}-\d{1,4}$/.test(m[2]) || /^(?:19|20)\d\d[- ](?:19|20)\d\d$/.test(m[2])) continue;
    const want = `${pre.length >= 4 ? pre : ''}${digits}`;
    if (!hays.some((h) => hinfo(h).lines.some((ln) => ln.toLowerCase().replace(/[\s-]+/g, '').includes(want)))) return { kind: 'id', claim: m[0].trim() };
  }
  return null;
}

const CUE_SUF = /\b(?:Jr|Sr|III|II|IV|Esq|MD|DDS|DMD|DVM|PhD|CPA|JD|RN|MBA)\b/;
const CUE_ROLE = /parent|guardian|director|emergency|pick-?\s?up|shipper|consignee|contractor|beneficiar|borrower|lender|insured|claimant|owner|manager/i;
const CUE_DATE = /\d[\/.-]\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d|\b20\d\d\b/i;
const CUE_MARK = /checked|ticked|selected|marked|opted|authori|signed|\bsign\b|initial|completed|unsigned|consent|agree|release|accept|void|cancel|supersed|rescind|revok|valid|active|effect|force|binding|final|approved/i;
const CUE_REF = /Article|Section|Exhibit|Schedule|Appendix|Clause|Paragraph|Addendum|Attachment|Annex/;
const CUE_Q = /\b(?:before|after|excl|including|inclusive|incl|plus|without|pre|post)\b|\+\s*tax/i;
/** all the sentence guards; returns the first failure {kind, claim} or null. Bounded work: long sentences are skipped by the callers' own size caps, cue words gate each guard. */
export function sentenceGuards(sent, hays, ctx = {}) {
  if (!D || !hays?.length || typeof sent !== 'string' || sent.length > 700) return null;
  const s = fixQ(sent);
  return (CUE_SUF.test(s) && suffixGuard(s, hays)) || (CUE_ROLE.test(s) && roleGuard(s, hays)) || (CUE_DATE.test(s) && dateLabelGuard(s, hays))
    || (CUE_MARK.test(s) && markerGuard(s, hays)) || (CUE_REF.test(s) && refGuard(s, hays)) || (s.includes('$') && CUE_Q.test(s) && qualifierGuard(s, hays))
    || (/\d[\d -]{5,}\d/.test(s) && idGuard(s, hays))
    || ((NEG_RE.test(s) || COND_RE.test(s) || hays.some((h) => hinfo(h).hasPol)) && polarityGuard(s, hays))
    || (ANT_CUE.test(s) && antonymGuard(s, hays)) || ((s.includes('$') && (MOD_ANY.test(s) || hays.some((h) => hinfo(h).hasMod))) && modifierGuard(s, hays))
    || (/\bfrom\b[\s\S]{0,60}\bto\b/i.test(s) && fromToGuard(s, hays)) || (/\d/.test(s) && figureLabelGuard(s, hays))
    || (LEX_CUE.test(s) || /owe|outstanding|unpaid|credit|half|quarter|third/i.test(s)) && statusGuard(s, hays, ctx) || (/[A-Z][a-z]{2,}\s+[A-Z]\.?\s+[A-Z]/.test(s) && initialGuard(s, hays))
    || (TOPIC_RE.test(s) && ((TOPIC_RE.lastIndex = 0), topicGuard(s, hays))) || null;
}
/** a card (label, value) read as a sentence for the role / suffix guards */
export function cardGuards(label, value, hays) {
  if (!D || !hays?.length) return null;
  const l = String(label ?? '').trim(); const v = String(value ?? '').trim(); if (!l || !v || l.length > 40 || v.length > 120) return null;
  const s = fixQ(`The ${l.toLowerCase()} is ${v}.`);
  return suffixGuard(s, hays) || roleGuard(s, hays) || initialGuard(s, hays) || (/\d[\d -]{5,}\d/.test(s) && idGuard(s, hays)) || null;
}

/* ------------------------------------------------------------------ cited page numbers */
/** A cited page must hold the document's figures that the answer claims; a page that does not exist, or lacks them while another page has them, is corrected or dropped. */
export function fixPages(data, evidence, extract, supportedIn) {
  try {
    const srcs = [...(data?.sources ?? []), ...(data?.facts ?? []).flatMap((f) => f.sources ?? [])];
    if (!srcs.some((s) => s?.documentId && Number.isInteger(s?.location?.page))) return data;
    if (String(data.text ?? '').length + String(data.interpretation ?? '').length > 3000) return data;
    const cache = new Map();
    const pick = (src, text) => {
      const ev = evidence?.get?.(src.documentId); const pages = ev?.pages; if (!pages?.size) return src;
      const page = src.location.page;
      const key = `${src.documentId}|${page}|${text.length}`;
      if (cache.has(key)) return cache.get(key);
      const full = [...pages.values()].join('\n');
      const figs = extract(text).filter((c) => (c.kind === 'money' || c.kind === 'date') && supportedIn(c, full));
      let out = src;
      if (!pages.has(page)) out = withPage(src, figs.length ? [...pages.entries()].filter(([, t]) => figs.every((c) => supportedIn(c, t))).map(([n]) => n)[0] : undefined);
      else if (figs.length && pages.size > 1 && figs.some((c) => !supportedIn(c, pages.get(page)))) {
        const all = [...pages.entries()].filter(([, t]) => figs.every((c) => supportedIn(c, t))).map(([n]) => n);
        out = all.length ? withPage(src, all[0]) : src;
      }
      cache.set(key, out); return out;
    };
    const withPage = (src, page) => { const loc = { ...src.location }; if (page == null) delete loc.page; else loc.page = page; return { ...src, location: loc }; };
    const text = `${data.text ?? ''}\n${data.interpretation ?? ''}`;
    const fixFact = (f) => { const t = `${text}\n${f.value ?? ''}`; return f.sources ? { ...f, sources: f.sources.map((s) => (s?.documentId && Number.isInteger(s?.location?.page) ? pick(s, t) : s)) } : f; };
    return { ...data, sources: (data.sources ?? []).map((s) => (s?.documentId && Number.isInteger(s?.location?.page) ? pick(s, text) : s)), ...(Array.isArray(data.facts) ? { facts: data.facts.map(fixFact) } : {}) };
  } catch { return data; }
}
