// R5 sealed-exam helpers: question normalisation, seeded split, rule-based paraphrases. No model, no api/ imports.
import crypto from "node:crypto";

export const normQ = (s) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9$'#/.@-]+/g, " ").replace(/(?<![a-z0-9])[.'-]+|[.'-]+(?![a-z0-9])/g, " ").replace(/\s+/g, " ").trim();
const CONTRACT = { whats: "what is", wheres: "where is", whos: "who is", hows: "how is", whens: "when is" };
const STOP = new Set(["a", "an", "the", "is", "was", "are", "were", "what", "where", "who", "when", "how", "can", "could", "you", "tell", "me", "please", "pls", "plz", "for", "of", "on", "to", "do", "does", "did", "s", "our", "we", "us", "i", "my", "it", "its", "there", "any", "give", "show", "find", "get", "know", "about", "with", "at", "in"]);
/** order-insensitive key: contractions expanded, possessive / wrappers / stop words dropped, tokens sorted. Paraphrases (not typos) share it. */
export function canonKey(q) {
  let t = normQ(q).replace(/'s\b/g, " ").replace(/'/g, "");
  t = t.split(" ").flatMap((w) => (CONTRACT[w] ? CONTRACT[w].split(" ") : [w])).join(" ");
  let toks = t.split(" ").filter((w) => w && !STOP.has(w));
  // possessive without apostrophe ("lindas phone") is not undone (unsafe); tokens that differ only by trailing s stay different
  if (toks.includes("phone")) toks = toks.filter((w) => w !== "number");
  return [...new Set(toks)].sort().join(" ");
}
/** 0..1 stable value for (seed, canonical question) */
export function unit(seed, q) { return crypto.createHash("sha256").update(`${seed}|${canonKey(q)}`).digest().readUInt32BE(0) / 2 ** 32; }
export const DEV_SHARE = 0.6;
export const sideOf = (seed, q) => (unit(seed, q) < DEV_SHARE ? "dev" : "sealed");

/** parse a question log: JSON array, JSON lines, or one question per line. Returns [{question, asked_at, org}] deduped by normalised text */
export function parseLog(text, { org = null } = {}) {
  const out = [], seen = new Set(); const t = String(text ?? "").trim();
  let rows = [];
  if (t.startsWith("[")) { try { rows = JSON.parse(t); } catch { rows = []; } }
  else for (const line of t.split(/\r?\n/)) { const l = line.trim(); if (!l) continue; if (l.startsWith("{")) { try { rows.push(JSON.parse(l)); continue; } catch { /* fall through */ } } rows.push(l); }
  for (const r of rows) {
    const o = typeof r === "string" ? { question: r } : r; const q = String(o?.question ?? o?.q ?? "").trim();
    if (!q) continue; const rowOrg = o.org ?? o.org_id ?? o.tenant_id ?? null;
    if (org && rowOrg && String(rowOrg) !== String(org)) continue;
    const k = normQ(q); if (!k || seen.has(k)) continue; seen.add(k);
    out.push({ question: q, asked_at: o.asked_at ?? o.created_at ?? null, org: rowOrg });
  }
  return out;
}

const FACTS = "phone number|phone|email|e-mail|address|due date|total|hours|technician|tech|fee|serial number|serial|refrigerant|hire date|hourly rate|job title|position|date";
export function paraphrases(q, seed = "x", max = 8) {
  const base = String(q).trim().replace(/\s+/g, " "); const out = new Map(); const n = normQ(base);
  const put = (s, kind) => { const v = s.replace(/\s+/g, " ").trim(); if (v && v !== base && !out.has(v.toLowerCase())) out.set(v.toLowerCase(), { text: v, kind }); };
  put(n, "plain");
  put(`pls ${n}`, "pls");
  put(`can you tell me ${n} please`, "wrap");
  if (/'s\b/i.test(base)) put(base.replace(/'s\b/gi, "s"), "possessive-drop"); else if (/\b[a-z]+s\b/i.test(base) && !/'/.test(base)) { /* no safe inverse */ }
  const contracted = n.replace(/\b(what|where|who|when) is\b/g, (m, w) => `${w}s`); if (contracted !== n) put(contracted, "contraction");
  const expanded = n.replace(/\b(what|where|who|when)s\b/g, (m, w) => `${w} is`); if (expanded !== n) put(expanded, "expand");
  // word-order swap: "<fact> for <name>"  <->  "<name> <fact>"
  let m = n.match(/^(?:what is the |what is |whats the |whats |who is the |when is the )?(.+?) (?:for|of|on) (.+)$/);
  if (m && new RegExp(`^(${FACTS})$`).test(m[1])) put(`${m[2]} ${m[1]}`, "swap");
  m = n.match(new RegExp(`^(.+?) (${FACTS})$`)); if (m) put(`${m[2]} for ${m[1]}`, "swap");
  m = n.match(/^(?:what is |whats )?(?:the )?(.+?)'?s? (phone number|phone|email|address|total|due date|fee)$/); if (m) put(`${m[2]} for ${m[1]}`, "swap");
  // typos on one alphabetic word of length >= 5: drop an inner letter; swap two inner letters (deterministic)
  const words = n.split(" "); const cand = words.map((w, i) => ({ w, i })).filter((x) => /^[a-z]{4,}$/.test(x.w));
  if (cand.length) {
    const h = (s) => crypto.createHash("sha256").update(`${seed}|${s}`).digest().readUInt32BE(0);
    const a = cand[h(base + "a") % cand.length], pos = 1 + (h(base + "p") % (a.w.length - 2));
    const w1 = words.slice(); w1[a.i] = a.w.slice(0, pos) + a.w.slice(pos + 1); put(w1.join(" "), "typo-drop");
    const b = cand[h(base + "b") % cand.length], p2 = 1 + (h(base + "q") % (b.w.length - 3));
    const sw = b.w.slice(0, p2) + b.w[p2 + 1] + b.w[p2] + b.w.slice(p2 + 2); if (sw !== b.w) { const w2 = words.slice(); w2[b.i] = sw; put(w2.join(" "), "typo-swap"); }
  }
  return [...out.values()].slice(0, max);
}
