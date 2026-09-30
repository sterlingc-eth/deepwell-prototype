/**
 * Round 28: builds api/_lib/support/kb.generated.js from docs/help/*.md.
 *
 *   node scripts/build-support-kb.mjs          write the generated file
 *   node scripts/build-support-kb.mjs --check  fail (exit 1) if the file on disk is stale
 *
 * Article format (docs/help/NN-slug.md):
 *
 *   ---
 *   id / title / audience (public|app) / surface (desktop|mobile|both) / keywords / updated
 *   ---
 *   <intro paragraph, model-only context>
 *
 *   ### A question a visitor might ask?
 *   ~ alternate phrasings, synonyms, keywords (comma separated; used by the $0 FAQ matcher only)
 *   The answer text. May contain **bold**, blank-line paragraph breaks and {{tokens}}.
 *   !handoff:reason        (optional: offer a hand-off to a person with this answer)
 *
 * PRICES ARE NEVER TYPED. Every dollar amount, login cap, page allowance and storage figure is a
 * {{token}} rendered from PLAN_CATALOG (billing.js), PLAN_LIMITS (plan.js) and RECORDS_RESCUE. The build
 * FAILS when an unresolved token exists, when a literal $ amount in an article is not one of the amounts
 * derived from those constants, or when index.html / public/terms.html disagree with PLAN_CATALOG.
 *
 * Tokens:  {{solo.monthly}} {{solo.annual}} {{solo.logins}} {{solo.docs}} {{solo.pages}} {{solo.name}}
 *          (solo|shop|crew|fleet)   {{rescue.rate}} {{rescue.min}} {{rescue.minPages}}
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PLAN_CATALOG, RECORDS_RESCUE, annualPrice } from '../api/_lib/billing.js';
import { PLAN_LIMITS } from '../api/_lib/plan.js';
import { estimateTokens } from '../api/_lib/promptCache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP_DIR = path.join(ROOT, 'docs', 'help');
const OUT = path.join(ROOT, 'api', '_lib', 'support', 'kb.generated.js');
const CHECK = process.argv.includes('--check');

const ALLOWED_EMAILS = new Set(['hello', 'support', 'billing', 'privacy', 'security', 'alert'].map((n) => `${n}@deepwelltechnology.com`));
const fmtInt = (n) => Number(n).toLocaleString('en-US');

/* ---------------------------------------------------------------- constants -> tokens */
const tokens = {};
const plans = {};
for (const [id, p] of Object.entries(PLAN_CATALOG)) {
  const l = PLAN_LIMITS[id];
  const logins = l.logins == null ? `${Object.values(PLAN_LIMITS).map((x) => x.logins).filter((x) => x != null).reduce((a, b) => Math.max(a, b), 0) + 1}+` : String(l.logins);
  plans[id] = {
    name: p.name.replace(/^DeepWell\s+/, ''),
    monthly: p.monthly,
    annual: annualPrice(p.monthly),
    logins,
    loginCap: l.logins,
    docs: l.documentsStored == null ? 'unlimited' : fmtInt(l.documentsStored),
    pages: fmtInt(l.pagesPerMonth),
    pagesRaw: l.pagesPerMonth,
  };
  const t = plans[id];
  tokens[`${id}.name`] = t.name;
  tokens[`${id}.monthly`] = fmtInt(t.monthly);
  tokens[`${id}.annual`] = fmtInt(t.annual);
  tokens[`${id}.logins`] = t.logins;
  tokens[`${id}.docs`] = t.docs;
  tokens[`${id}.pages`] = t.pages;
}
const rescueRate = (RECORDS_RESCUE.unitPriceCents / 100).toFixed(2);
const rescueMin = Math.floor((RECORDS_RESCUE.minUnits * RECORDS_RESCUE.unitPriceCents) / 100);
tokens['rescue.rate'] = rescueRate;
tokens['rescue.min'] = fmtInt(rescueMin);
tokens['rescue.minPages'] = fmtInt(RECORDS_RESCUE.minUnits);

const allowedAmounts = new Set([rescueRate, fmtInt(rescueMin)]);
for (const t of Object.values(plans)) { allowedAmounts.add(fmtInt(t.monthly)); allowedAmounts.add(fmtInt(t.annual)); }

/* ---------------------------------------------------------------- parse */
const errors = [];
const fail = (m) => errors.push(m);

function parseFrontMatter(src, file) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) { fail(`${file}: missing front-matter`); return null; }
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of ['id', 'title', 'audience', 'surface', 'keywords', 'updated']) if (!meta[k]) fail(`${file}: front-matter missing "${k}"`);
  if (meta.audience && !['public', 'app'].includes(meta.audience)) fail(`${file}: audience must be public|app`);
  if (meta.surface && !['desktop', 'mobile', 'both'].includes(meta.surface)) fail(`${file}: surface must be desktop|mobile|both`);
  return { meta, body: m[2] };
}

function render(text, file) {
  return text.replace(/\{\{([a-zA-Z.]+)\}\}/g, (_, k) => {
    if (!(k in tokens)) { fail(`${file}: unknown token {{${k}}}`); return `{{${k}}}`; }
    return tokens[k];
  });
}

const files = fs.readdirSync(HELP_DIR).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const articles = [];
const entries = [];
const modelParts = [];
const seenIds = new Set();

for (const file of files) {
  const parsed = parseFrontMatter(fs.readFileSync(path.join(HELP_DIR, file), 'utf8'), file);
  if (!parsed) continue;
  const { meta, body } = parsed;
  if (seenIds.has(meta.id)) fail(`${file}: duplicate article id ${meta.id}`);
  seenIds.add(meta.id);
  const parts = body.split(/^### /m);
  const intro = render(parts.shift().trim(), file);
  const artKw = meta.keywords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  articles.push({ id: meta.id, title: meta.title, audience: meta.audience, surface: meta.surface, updated: meta.updated, keywords: artKw, intro });
  const modelLines = [`## ${meta.title} [article_id: ${meta.id}]`, intro];
  let n = 0;
  for (const part of parts) {
    const lines = part.split('\n');
    const q = lines.shift().trim();
    let kw = [];
    let handoff = null;
    const ans = [];
    for (const line of lines) {
      if (line.startsWith('~ ')) kw = kw.concat(line.slice(2).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
      else if (line.startsWith('!handoff:')) handoff = line.slice(9).trim() || 'requested';
      else ans.push(line);
    }
    const a = render(ans.join('\n').trim().replace(/\n{3,}/g, '\n\n'), file);
    if (!q || !a) { fail(`${file}: entry "${q}" has no answer`); continue; }
    if (a.length > 900) fail(`${file}: answer for "${q}" is ${a.length} chars (max 900)`);
    n += 1;
    entries.push({ id: `${meta.id}#${n}`, article: meta.id, q, a, kw, handoff });
    modelLines.push(`Q: ${q}\nA: ${a}`);
  }
  if (n === 0) fail(`${file}: no entries`);
  modelParts.push(modelLines.join('\n'));
}

/* ---------------------------------------------------------------- parity + hygiene checks */
const allText = [...entries.map((e) => e.a), ...articles.map((a) => a.intro)].join('\n');
for (const m of allText.matchAll(/\$(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g)) {
  if (!allowedAmounts.has(m[1])) fail(`literal price "$${m[1]}" in the KB is not derived from PLAN_CATALOG / RECORDS_RESCUE`);
}
for (const m of allText.matchAll(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)) {
  if (!ALLOWED_EMAILS.has(m[0].toLowerCase())) fail(`unexpected email address in KB: ${m[0]}`);
}
for (const e of entries) {
  if (/soc ?2/i.test(e.a) && !/\bno soc|not soc|no \*\*soc|has no|hasn't|isn't|can't claim|openly/i.test(e.a)) fail(`${e.id}: mentions SOC 2 without a negation`);
}

function stripHtml(s) {
  return s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, '\n').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
const parity = [];
try {
  const idx = stripHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  for (const [id, p] of Object.entries(plans)) {
    const re = new RegExp(`\\b${p.name}\\b[^$]{0,140}\\$\\s?(\\d[\\d,]*)`);
    const m = re.exec(idx);
    if (!m) fail(`index.html: could not find the ${p.name} price to check parity`);
    else if (Number(m[1].replace(/,/g, '')) !== p.monthly) fail(`index.html shows $${m[1]} for ${p.name} but PLAN_CATALOG says $${p.monthly}`);
    else parity.push(`index.html ${p.name} $${p.monthly}`);
  }
  const rr = /\$0\.12\s?\/\s?page/.exec(idx);
  if (!rr) fail('index.html: Records Rescue $0.12/page not found');
  else if (rr[0].replace(/\s/g, '') !== `$${rescueRate}/page`) fail('index.html Records Rescue rate differs');
} catch (err) { fail(`index.html parity check could not run: ${err.message}`); }
try {
  const terms = stripHtml(fs.readFileSync(path.join(ROOT, 'public', 'terms.html'), 'utf8'));
  for (const p of Object.values(plans)) {
    if (!terms.includes(`${p.name} $${p.monthly}/mo`) && !terms.includes(`${p.name} $${p.monthly}+/mo`)) fail(`public/terms.html does not state "${p.name} $${p.monthly}/mo"`);
    else parity.push(`terms.html ${p.name} $${p.monthly}`);
  }
  if (!terms.includes(`$${rescueRate}/page`)) fail('public/terms.html Records Rescue rate differs');
} catch (err) { fail(`terms.html parity check could not run: ${err.message}`); }

/* ---------------------------------------------------------------- emit */
const modelKb = modelParts.join('\n\n');
const modelKbTokens = estimateTokens(modelKb);
const hash = crypto.createHash('sha256').update(JSON.stringify({ articles, entries, plans })).digest('hex').slice(0, 12);

const out = `/* GENERATED by scripts/build-support-kb.mjs from docs/help/*.md — DO NOT EDIT BY HAND.
 * Prices, logins, page allowances and storage figures are rendered from PLAN_CATALOG / PLAN_LIMITS /
 * RECORDS_RESCUE at build time; scripts/verify-support-assistant.mjs re-checks parity and freshness. */
export const KB_VERSION = ${JSON.stringify(hash)};
export const ARTICLES = ${JSON.stringify(articles, null, 1)};
export const ENTRIES = ${JSON.stringify(entries, null, 1)};
export const PRICES = ${JSON.stringify({ plans, rescue: { rate: rescueRate, min: rescueMin, minPages: RECORDS_RESCUE.minUnits }, allowedAmounts: [...allowedAmounts] }, null, 1)};
export const MODEL_KB = ${JSON.stringify(modelKb)};
`;

if (errors.length) {
  console.error(`build-support-kb: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  FAIL ${e}`);
  process.exit(1);
}

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== out) {
    console.error('build-support-kb --check: api/_lib/support/kb.generated.js is stale. Run `npm run build:support-kb`.');
    process.exit(1);
  }
  console.log(`build-support-kb --check: up to date (${articles.length} articles, ${entries.length} entries, parity ok: ${parity.length} price checks)`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`build-support-kb: wrote ${path.relative(ROOT, OUT)} — ${articles.length} articles, ${entries.length} entries, ~${modelKbTokens} model-KB tokens, ${parity.length} price parity checks passed`);
}
