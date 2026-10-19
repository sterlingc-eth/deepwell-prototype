/** s1.js - port of lib/reader_s1.py: the first (rule) reader, used as the second candidate source. */
import { words, stem, hum, STOP, DOCNO_SRC, parseDates, has } from './text.js';
import { isAlnum, sortedBy, cap, fmtMoney } from './pyc.js';
const DOCNO = () => new RegExp(DOCNO_SRC, 'g');
const SEP = '\u0001';
const spaces = (n) => ' '.repeat(n);
export function ground1(ix, q) {
  const ql = q.toLowerCase().replace(/’/g, "'");
  const g = { q, ql, nums: [], unknown_nums: [], ents: [], dates: parseDates(q), types: [], ambiguous: false };
  for (const m of q.matchAll(DOCNO())) {
    const k = m[0].toLowerCase();
    if (ix.num2docs.has(k)) { if (ix.num2docs.get(k).length === 1) g.nums.push(ix.num2docs.get(k)[0]); else g.ambiguous = true; } else g.unknown_nums.push(m[0]);
  }
  const cands = [];
  for (const [n, eids] of ix.name2ents) {
    let i = ql.indexOf(n);
    while (i >= 0) { if ((i === 0 || !isAlnum(ql[i - 1])) && (i + n.length >= ql.length || !isAlnum(ql[i + n.length]))) cands.push([i, i + n.length, n, eids]); i = ql.indexOf(n, i + 1); }
  }
  for (const [a, eids] of ix.addr2ents) { const i = ql.indexOf(a); if (i >= 0) cands.push([i, i + a.length, a, eids]); }
  const taken = [];
  for (const [st, en, n, eids] of sortedBy(cands, (x) => -(x[1] - x[0]))) {
    if (taken.some(([a, b]) => !(en <= a || st >= b))) continue;
    taken.push([st, en]); g.ents.push([n, eids, ix.addr2ents.has(n)]);
  }
  let mask = ql;
  for (const [st, en] of sortedBy(taken, (x) => x, true)) mask = mask.slice(0, st) + spaces(en - st) + mask.slice(en);
  for (const m of mask.matchAll(DOCNO())) mask = mask.slice(0, m.index) + spaces(m[0].length) + mask.slice(m.index + m[0].length);
  for (const [[a, b]] of g.dates) mask = mask.slice(0, a) + spaces(b - a) + mask.slice(b);
  g.mask = mask;
  const wq = words(mask), sq = wq.map(stem); let best = [];
  for (const t of [...ix.tphr.keys(), ...ix.restricted]) {
    const pw = words(hum(t)), spw = pw.map(stem), L = spw.length;
    for (let i = 0; i <= sq.length - L; i++) { let eq = true; for (let j = 0; j < L; j++) if (sq[i + j] !== spw[j]) { eq = false; break; } if (eq) { best.push([L, t, wq[i + L - 1] !== pw[pw.length - 1]]); break; } }
  }
  best = sortedBy(best, (x) => x, true);
  g.restricted = best.filter(([, t]) => ix.restricted.has(t)).map(([, t]) => t);
  best = best.filter((b) => !ix.restricted.has(b[1]));
  if (best.length) { const top = best[0][0]; g.types = best.filter(([l]) => l === top).map(([, t, pl]) => [t, pl]); }
  return g;
}
export function decide(ix, q) {
  const g = ground1(ix, q); const ql = g.ql, mask = g.mask;
  const no = (reason, intent = null) => ({ answered: false, text: 'Not on file / released: ' + reason, docs: [], conf: 0.0, intent, reason });
  const ok = (text, docs, conf, intent) => ({ answered: true, text, docs, conf, intent, reason: '' });
  if (g.ambiguous) return no('ambiguous number');
  if (g.restricted.length) return no('restricted document type', 'restricted');
  const nums = g.nums, ents = g.ents, types = g.types;
  if (g.unknown_nums.length && !nums.length) return no('number not found in your records: ' + g.unknown_nums[0], 'notfound');
  let ent = null;
  if (ents.length) { const [, eids] = ents[0]; if (eids.length > 1) return no('name matches more than one record'); ent = eids[0]; }
  const W = new Set(words(mask));
  const is_count = has(ql, 'how many', 'number of', 'count');
  const is_latest = has(ql, 'latest', 'most recent', 'newest', 'last');
  const is_earliest = has(ql, 'earliest', 'oldest', 'first', 'very first');
  const is_max = has(ql, 'highest', 'largest', 'biggest', 'top');
  const is_min = has(ql, 'lowest', 'smallest', 'cheapest');
  const is_list = has(ql, 'list', 'every', 'all', 'show me', 'give me', 'pull up') || /\bwhich \w+( \w+)? (does|do|did)\b/.test(ql);
  const is_sum = has(ql, 'combined', 'sum', 'add up', 'come to', 'total', 'totals', 'total of') && !nums.length;
  const is_mention = has(ql, 'mention', 'mentions', 'reference', 'references', 'referenced', 'search') || (W.has('have') && ql.includes('in them'));
  const contact = [['phone', 'phone'], ['email', 'email'], ['address', 'service_address']].filter(([w]) => has(ql, w)).map(([, k]) => k);
  if (is_mention) {
    if (g.unknown_nums.length) return no('not found: ' + g.unknown_nums[0]);
    let raw = null; const m = new RegExp(DOCNO_SRC).exec(q);
    if (m) raw = m[0]; else if (ents.length) raw = ents[0][0];
    if (!raw) return no('nothing to search for', 'mention');
    const rl = raw.toLowerCase(); const hits = [...ix.D.keys()].filter((did) => ix.c.text(did).toLowerCase().includes(rl) && !ix.D.get(did).restricted);
    if (!hits.length) return no('no document mentions it', 'mention');
    if (hits.length > 12) return no('too many documents; narrow the search', 'mention');
    return ok('Mentioned in: ' + hits.map((h) => ix.cite(ix.D.get(h))).join('; '), hits, 0.995, 'mention');
  }
  if (ents.length && ents[0][2] && !nums.length && !types.length && has(ql, 'who', 'whose', 'name', 'lives', 'at')) return ok(`${ix.name(ent)} is at ${ix.c.cust.get(ent).data.service_address}.`, [], 0.995, 'who_by_address');
  if (ent && contact.length && !types.length && !nums.length) {
    const v = ix.c.cust.get(ent).data[contact[0]];
    if (!v) return no('no ' + contact[0] + ' on file', 'contact');
    return ok(`${ix.name(ent)}: ${v}`, [], 0.995, 'contact');
  }
  if (contact.length && !ent && !types.length && !nums.length) return no('person not found', 'contact');
  let docref = null;
  if (nums.length) docref = ix.D.get(nums[0]);
  else if (ent && types.length && g.dates.length) {
    const xs = ix.by_c_date.get(ent + SEP + types[0][0] + SEP + g.dates[0][1]) || [];
    if (xs.length === 1) docref = xs[0]; else if (xs.length > 1) return no('more than one matching document'); else return no('no such document on file for that date', 'docref');
  }
  if (docref !== null) {
    const x = docref; const qw = new Set(words(mask).map(stem)); let F = [];
    for (const [k, ph] of ix.fields) if (x.fields.has(k)) { const fw = words(ph).map(stem); if (fw.length && fw.every((w) => qw.has(w))) F.push([fw.length, k]); }
    F = sortedBy(F, (z) => z, true);
    if (F.length && !(F.length > 1 && F[0][0] === F[1][0])) { const k = F[0][1]; const v = x.fields.get(k); if (v) return ok(`${cap(hum(k))}: ${v} (${ix.cite(x)})`, [x.id], 0.98, 'field'); }
    const MARK = new Set(['say', 'clause', 'term', 'language', 'handle', 'about', 'written', 'provision']);
    let GEN = new Set(['total', 'amount', 'much', 'dollar', 'price', 'date', 'when', 'day', 'who', 'whose', 'name', 'find', 'pull', 'open', 'locate', 'show', 'see', 'get', 'where', 'issued', 'dated', 'belongs', 'which', 'listed', 'whn', 'is']);
    GEN = new Set([...GEN, ...MARK, ...ix.labelw]);
    const ref_w = types.length ? new Set(words(hum(types[0][0])).map(stem)) : new Set();
    const cw = words(mask).filter((w) => w.length > 1 && !STOP.has(w) && !GEN.has(stem(w)) && !ref_w.has(stem(w))).map(stem);
    const marker = [...qw].some((w) => MARK.has(w));
    if (cw.length || marker) {
      if (!cw.length) return no('could not tell what to read', 'clause');
      let den = 0; for (const w of cw) den += ix.idf.has(w) ? ix.idf.get(w) : ix.idf_default;
      let sc = [];
      for (const [pg, ln, ws] of ix.lines.get(x.id)) { let s = 0; for (const w of cw) if (ws.has(w)) s += ix.idf.has(w) ? ix.idf.get(w) : ix.idf_default; sc.push([s / den, pg, ln]); }
      sc = sortedBy(sc, (z) => z, true);
      if (!sc.length || sc[0][0] < 0.5 || (sc.length > 1 && sc[1][0] >= sc[0][0] - 0.2 && sc[1][0] > 0)) return no('could not find a clear passage', 'clause');
      return ok(`${sc[0][2]} (page ${sc[0][1]}, ${ix.cite(x)})`, [x.id], 0.9 + 0.1 * sc[0][0], 'clause');
    }
    if (has(ql, 'total', 'amount', 'much', 'dollar', 'dollars', 'price')) {
      const used = !qw.has('total') ? ['amount', 'price'].filter((w) => qw.has(w)) : [];
      if (used.length && ix.lines.get(x.id).some(([, ln, ws]) => used.some((w) => ws.has(w)) && /\d/.test(ln))) return no('could be the document total or a figure inside it', 'total');
      if (x.tot === null) return no('no total on that document', 'total');
      return ok(`Total: ${fmtMoney(x.tot)} (${ix.cite(x)})`, [x.id], 0.995, 'total');
    }
    if (has(ql, 'who', 'whose', 'name', 'belongs') || /\bwhich \w+ (is|on)/.test(ql)) { if (!x.cust) return no('no name on that document', 'party'); return ok(`${ix.name(x.cust)} (${ix.cite(x)})`, [x.id], 0.99, 'party'); }
    if (has(ql, 'find', 'pull', 'open', 'locate', 'where', 'show', 'see', 'get')) return ok(`${ix.cite(x)}`, [x.id], 0.995, 'find');
    if (has(ql, 'date', 'when', 'day', 'issued', 'dated', 'whn')) return ok(`Date: ${x.date} (${ix.cite(x)})`, [x.id], 0.99, 'date');
    return no('could not tell what to read', 'docref');
  }
  if (types.length) {
    const [t, pl] = types[0];
    if (types.length > 1) return no('document type unclear');
    if (ent) {
      const xs = ix.by_ct.get(ent + SEP + t) || []; const nm = ix.name(ent);
      if (!xs.length) return is_count ? ok(`${nm} has no ${hum(t)}s on file.`, [], 0.99, 'count0') : no('none on file', 'agg');
      if (is_count) return ok(`${nm} has ${xs.length} ${hum(t)}${xs.length !== 1 ? 's' : ''} on file.`, xs.map((x) => x.id), 0.99, 'count');
      if (is_sum && pl) {
        if (xs.some((x) => x.tot === null)) return no('some documents have no total');
        let s = 0; for (const x of xs) s += x.tot;
        return ok(`Total of ${xs.length} ${hum(t)}s for ${nm}: ${fmtMoney(s)}`, xs.map((x) => x.id), 0.99, 'sum');
      }
      if (is_latest || is_earliest) {
        const ds = sortedBy(xs, (x) => x.date); const y = is_latest && !is_earliest ? ds[ds.length - 1] : ds[0];
        if (ds.length > 1 && ((is_latest && ds[ds.length - 1].date === ds[ds.length - 2].date) || (!is_latest && ds[0].date === ds[1].date))) return no('tie');
        return ok(`${is_latest && !is_earliest ? 'Latest' : 'Earliest'} ${hum(t)} for ${nm}: ${y.date} (${ix.cite(y)})`, [y.id], 0.99, 'latest');
      }
      if (is_list || pl) return ok(`${nm}'s ${hum(t)}s: ` + sortedBy(xs, (x) => x.date).map((x) => ix.cite(x)).join('; '), xs.map((x) => x.id), 0.98, 'list');
      return no('unsure what is being asked', 'agg');
    } else {
      const xs = ix.by_t.get(t) || [];
      const yrs = [...mask.matchAll(/\b(20\d\d|19\d\d)\b/g)].map((m) => m[1]);
      if (is_count && yrs.length) { const n = xs.filter((x) => x.date.slice(0, 4) === yrs[0]); return ok(`${n.length} ${hum(t)}s dated ${yrs[0]}.`, n.map((x) => x.id).slice(0, 50), 0.99, 'count_year'); }
      if (is_max || is_min) {
        const wt = sortedBy(xs.filter((x) => x.tot !== null), (x) => x.tot);
        if (wt.length < 2 || (is_max && wt[wt.length - 1].tot === wt[wt.length - 2].tot) || (is_min && wt[0].tot === wt[1].tot)) return no('tie or no totals');
        const y = is_max ? wt[wt.length - 1] : wt[0];
        return ok(`${is_max ? 'Highest' : 'Lowest'} ${hum(t)}: ${fmtMoney(y.tot)} (${ix.cite(y)})`, [y.id], 0.99, 'maxmin');
      }
    }
  }
  if (is_count && types !== null && !types.length) return no('document type unclear', 'count');
  return no('could not ground the question in your records');
}
