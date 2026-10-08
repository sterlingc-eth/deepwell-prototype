// R41U phrasing matrix: ask ONE supported question ~10 ways (lower case, no punctuation, typo, no $, wheres/whats, role words, reordered, extra politeness...)
// and require the SAME answer facts every time. Truth comes from raw rows via truthFn, never from Donovan.
//
//   const res = await runMatrix(askFn, { truthFn, rows: [{ name, variants: standardVariants({ noun: "invoice", num: "3470", role: "customer" }), truth: {...} }], check })
//   askFn(question) -> { text, kind, facts, calls, ms?, shown? }   (any extra fields are passed to truthFn)
//   truthFn(row, result) -> { include: [string|RegExp...], exclude: [string|RegExp...], kind?: "answer"|"no-answer", maxCalls?: 0, maxMs?: n }  (default: row.truth)
//   check(name, ok, detail) is the shared r41u check(); when given, every variant is one check.
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
const has = (hay, needle) => (needle instanceof RegExp ? needle.test(hay) : norm(hay).includes(norm(needle)));

/** ~10 ways of asking for "the <noun> for <num>", optionally from a <role>. */
export function standardVariants({ noun = "invoice", num, role = null, plural = null }) {
  const n = String(num); const dollar = /^\d+(\.\d+)?$/.test(n) ? `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: n.includes(".") ? 2 : 0 })}` : n;
  const typo = noun.length > 4 ? noun.slice(0, 3) + noun.slice(4) : noun; // invoice -> invice
  const out = [
    `the ${noun} for ${n}`,
    `wheres the ${noun} for ${n}`,
    `whats the ${noun} for ${n}`,
    `Where's the ${noun} for ${n}?`,
    `show me the ${noun} for ${dollar}`,
    `wheres the ${typo} for ${n}`,
    `${n} ${noun}`,
    `can you please show me the ${noun} for ${n}`,
    `find me ${noun} ${n}`,
    `WHERES THE ${noun.toUpperCase()} FOR ${n}`,
  ];
  if (role) out.push(`wheres the ${noun} for ${n} from a ${role}`, `${noun} for ${n} ${role}`);
  return out;
}

export async function runMatrix(askFn, { truthFn = null, rows, check = null, label = "matrix" }) {
  const failures = []; const lats = []; let total = 0;
  for (const row of rows) {
    for (const q of row.variants) {
      total++;
      const t = Date.now(); let r; let err = null;
      try { r = await askFn(q); } catch (e) { err = e; }
      const ms = r?.ms ?? Date.now() - t; lats.push(ms);
      let ok = !err; let why = err ? String(err?.stack ?? err) : "";
      if (ok) {
        const tr = (truthFn ? await truthFn(row, r) : row.truth) ?? {};
        const shown = r.shown ?? `${r.text ?? ""}\n${(r.facts ?? []).map((f) => `${f.label} ${f.value}`).join("\n")}`;
        const miss = (tr.include ?? []).filter((x) => !has(shown, x)); const bad = (tr.exclude ?? []).filter((x) => has(shown, x));
        if (miss.length) { ok = false; why += ` missing ${JSON.stringify(miss.map(String))}`; }
        if (bad.length) { ok = false; why += ` forbidden ${JSON.stringify(bad.map(String))}`; }
        if (tr.kind && r.kind !== tr.kind) { ok = false; why += ` kind ${r.kind} != ${tr.kind}`; }
        if (tr.maxCalls != null && (r.calls ?? 0) > tr.maxCalls) { ok = false; why += ` model calls ${r.calls}`; }
        if (tr.maxMs != null && ms > tr.maxMs) { ok = false; why += ` took ${ms} ms`; }
        if (!ok) why += ` :: ${String(r.text).slice(0, 200)}`;
      }
      if (!ok) failures.push({ row: row.name, q, why });
      if (check) check(`${label}: ${row.name} [${q}]`, ok, why);
    }
  }
  const s = [...lats].sort((a, b) => a - b); const pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  return { total, failures, p50: pct(0.5), p95: pct(0.95), max: s[s.length - 1] ?? 0 };
}
