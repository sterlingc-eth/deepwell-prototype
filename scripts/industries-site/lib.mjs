// Industries site generator: ONE template (render functions below) + ONE data file (data.json).
// data.json holds only facts copied from src/demo/fixtures/*.demo.json (run `node scripts/industries-site/build.mjs --refresh`).
// Shared look: CSS, nav, footer and scripts are lifted at build time from public/industries/offices.html, so the pages stay in sync with the site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SITE = 'https://deepwelltechnology.com';
export const SHELL_SOURCE = 'public/industries/offices.html';
export const DATA_FILE = path.join(ROOT, 'scripts/industries-site/data.json');
const FIXTURES = path.join(ROOT, 'src/demo/fixtures');

/** Hub groups: every demo slug appears in exactly one group (checked by the verify script). */
export const GROUPS = [
  { id: 'trades', title: 'Trades & field service', blurb: 'Crews on the road and paperwork in the truck.', slugs: ['plumbing-hvac', 'electrical', 'general-contractor', 'roofing', 'landscaping', 'pestcontrol', 'poolservice', 'cleaning', 'auto'] },
  { id: 'property', title: 'Property & real estate', blurb: 'Listings, leases, rentals and units.', slugs: ['realty', 'property-management', 'storage'] },
  { id: 'hospitality', title: 'Hospitality, events & food', blurb: 'Guests, bookings, menus and suppliers.', slugs: ['hotel', 'eventvenue', 'marina', 'weddingplan', 'restaurant', 'brewery', 'foodtruck'] },
  { id: 'professional', title: 'Professional services & offices', blurb: 'Client files, engagements and policies.', slugs: ['bookkeeping', 'legal', 'insagency', 'msp', 'filmprod', 'photostudio', 'tutoring'] },
  { id: 'health', title: 'Healthcare & personal care', blurb: 'Patients, clients and appointments.', slugs: ['medicaloffice', 'dentaloffice', 'dentallabco', 'medbillingco', 'vetclinic', 'petgroomco', 'gymfit', 'salonspa', 'daycarecenter'] },
  { id: 'community', title: 'Nonprofit & community', blurb: 'Grants, members, donors and public records.', slugs: ['nonprofit', 'grantnp', 'church', 'policerecords'] },
  { id: 'transport', title: 'Transport, goods & manufacturing', blurb: 'Loads, stock, batches and quality records.', slugs: ['trucking', 'warehouse', 'mfgqa', 'feedstore'] },
];

/** Industries that already have a hand-written page; those pages are linked, never regenerated. */
export const EXISTING_PAGES = {
  'plumbing-hvac': 'hvac.html',
  electrical: 'electrical.html',
  'property-management': 'property-management.html',
  'general-contractor': 'contractors.html',
  nonprofit: 'nonprofits.html',
};
/** Other hand-written pages, linked from the hub as extra guides (not demo industries). */
export const EXTRA_GUIDES = [
  { href: '/industries/any-business.html', title: 'Any business', note: 'If you keep paperwork, it works.' },
  { href: '/industries/offices.html', title: 'Offices', note: 'Vendor contracts, agreements and forms.' },
  { href: '/industries/fleet-equipment-rental.html', title: 'Fleet and equipment rental', note: 'Service records, inspections and rental agreements.' },
  { href: '/industries/plumbing.html', title: 'Plumbing', note: 'Service tickets, permits and warranty paperwork.' },
];

export const pageFile = (slug) => EXISTING_PAGES[slug] ?? `${slug}.html`;
export const demoLink = (slug) => `/demo/?industry=${encodeURIComponent(slug)}`;
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Pull the facts out of the demo fixtures. */
export function extractData() {
  const idx = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.json'), 'utf8')).industries;
  const out = [];
  for (const i of idx) {
    const f = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${i.slug}.demo.json`), 'utf8'));
    const byId = new Map(f.documents.map((d) => [d.id, d]));
    const counts = new Map();
    for (const d of f.documents) counts.set(d.typeLabel, (counts.get(d.typeLabel) ?? 0) + 1);
    const docTypes = [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const questions = f.questions.filter((q) => q.answer && (q.answer.headline || q.answer.text)).map((q) => ({
      q: q.q,
      answer: q.answer.headline || q.answer.text,
      source: q.answer.docs?.[0] && byId.get(q.answer.docs[0]) ? byId.get(q.answer.docs[0]).name : null,
    }));
    out.push({
      slug: i.slug, label: i.label, company: f.company,
      documents: f.documents.length, customers: f.customers.length,
      docTypes, questions,
    });
  }
  return { source: 'src/demo/fixtures/*.demo.json', synthetic: true, industries: out };
}

export const loadData = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
export const groupOf = (slug) => GROUPS.find((g) => g.slugs.includes(slug));

function shell() {
  const src = fs.readFileSync(path.join(ROOT, SHELL_SOURCE), 'utf8');
  const style = src.slice(src.indexOf('<style>') + 7, src.indexOf('/* ── new industry pages'));
  const fonts = src.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/)[0];
  const nav = src.slice(src.indexOf('<nav class="nav"'), src.indexOf('</nav>') + 6);
  const footer = src.slice(src.indexOf('<footer>'), src.indexOf('</footer>') + 9);
  const afterFooter = src.slice(src.indexOf('</footer>') + 9);
  const ddStart = afterFooter.indexOf('<script>');
  const dropdown = afterFooter.slice(ddStart, afterFooter.indexOf('</script>', ddStart) + 9);
  const tail = ['<script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>', '<script defer src="/_vercel/insights/script.js"></script>', '<script defer src="/support/widget.js"></script>'].join('\n');
  return { style, fonts, nav, footer, dropdown, tail };
}

const EXTRA_CSS = `
.wrap.wide{max-width:1080px}
h3{font-family:"Newsreader",Georgia,serif;font-weight:500;font-size:1.05rem;line-height:1.2;margin:0 0 6px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 36px}
.stat{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--surface)}
.stat b{display:block;font-family:"Newsreader",Georgia,serif;font-weight:500;font-size:1.8rem;line-height:1.1}
.stat span{font-size:.84rem;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0;padding:0;list-style:none}
.chips li{border:1px solid var(--line-strong);border-radius:20px;padding:4px 12px;font-size:.88rem;color:var(--muted)}
.chips li b{color:var(--text);font-weight:600}
.qa{display:grid;gap:12px;margin:14px 0 36px;padding:0;list-style:none}
.qa li{border:1px solid var(--line);border-radius:10px;padding:14px 18px;background:var(--surface)}
.qa .q{font-weight:600}
.qa .a{margin-top:4px;color:var(--text)}
.qa .src{margin-top:2px;font-size:.84rem;color:var(--faint)}
.note{font-size:.88rem;color:var(--faint);margin:0 0 36px}
.sec{margin:0 0 6px}
.hub-tools{display:flex;flex-direction:column;gap:12px;margin:8px 0 28px}
.hub-search{width:100%;max-width:520px;min-height:44px;padding:10px 14px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);color:var(--text);font:inherit}
.hub-filters{display:flex;flex-wrap:wrap;gap:8px}
.hub-filters button{min-height:40px;padding:6px 14px;border-radius:20px;border:1px solid var(--line-strong);background:transparent;color:var(--muted);font:inherit;font-size:.88rem;cursor:pointer}
.hub-filters button[aria-pressed="true"]{background:var(--well);border-color:var(--well);color:#fff}
.hub-count{font-size:.88rem;color:var(--faint)}
.hub-group{margin:0 0 40px}
.hub-group>p{color:var(--muted);margin:0 0 14px;font-size:.94rem}
.hub-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;list-style:none;margin:0;padding:0}
.hub-card{border:1px solid var(--line);border-radius:10px;padding:16px 18px;background:var(--surface);display:flex;flex-direction:column;gap:6px;height:100%}
.hub-card h3{margin:0}
.hub-card h3 a{text-decoration:none}
.hub-card h3 a:hover{text-decoration:underline}
.hub-card p{margin:0;color:var(--muted);font-size:.88rem}
.hub-card .row{display:flex;gap:14px;flex-wrap:wrap;margin-top:auto;padding-top:8px;font-size:.9rem;font-weight:600}
.hub-card .row a{display:inline-flex;align-items:center;min-height:44px}
.hub-card .row a.go{color:var(--brass-text)}
.hub-empty{display:none;padding:20px;border:1px dashed var(--line-strong);border-radius:10px;color:var(--muted)}
.hub-guides{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:8px}
.hub-guides a{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;text-decoration:none;min-height:44px;align-content:center}
.hub-guides a b{font-weight:600}
.hub-guides a span{color:var(--muted);font-size:.9rem}
.related{display:flex;flex-wrap:wrap;gap:8px 18px;margin:12px 0 0;padding:0;list-style:none}
.related a{display:inline-flex;align-items:center;min-height:44px;color:var(--muted)}
`;

function page({ title, description, canonicalPath, body }) {
  const s = shell();
  const url = SITE + canonicalPath;
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name" content="DeepWell Technology">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/og-image.jpg">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0B1613">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${s.fonts}
<style>${s.style}${EXTRA_CSS}</style>
</head>
<body>
${s.nav}
${body}
${s.footer}
${s.dropdown}
${s.tail}
</body>
</html>
`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function renderIndustry(d, all) {
  const g = groupOf(d.slug);
  const types = d.docTypes.map((t) => t.label.toLowerCase());
  const top = d.docTypes.slice(0, 3).map((t) => t.label.toLowerCase());
  let description = `DeepWell for ${d.label.toLowerCase()}: a sample workspace of ${d.documents} documents (${top.slice(0, 2).join(', ')} and more), with example questions answered and linked to the source.`;
  if (description.length > 160) description = `DeepWell for ${d.label.toLowerCase()}: a sample workspace of ${d.documents} documents, with example questions answered and linked to the source.`;
  const title = `${d.label} — DeepWell Technology`;
  const related = g.slugs.filter((s) => s !== d.slug).map((s) => all.find((x) => x.slug === s)).filter(Boolean);
  const body = `<main class="wrap">
  <div class="hero-block">
    <div class="eyebrow">Who it&rsquo;s for · ${esc(d.label)}</div>
    <h1>DeepWell for ${esc(d.label.toLowerCase())}</h1>
    <p class="lede">The ${esc(d.label.toLowerCase())} demo is a sample workspace for ${esc(d.company)}, a made-up company. DeepWell reads its ${d.documents} documents (${types.slice(0, 4).map(esc).join(', ')}${types.length > 4 ? ' and more' : ''}) and answers questions about them, with a link back to the page each answer came from.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="${demoLink(d.slug)}">Try the ${esc(d.label.toLowerCase())} demo</a>
      <a class="btn btn-ghost" href="/industries/">All industries</a>
    </div>
  </div>

  <div class="stats" role="list" aria-label="Sample workspace at a glance">
    <div class="stat" role="listitem"><b>${d.documents}</b><span>documents in the sample</span></div>
    <div class="stat" role="listitem"><b>${d.docTypes.length}</b><span>document types</span></div>
    <div class="stat" role="listitem"><b>${d.customers}</b><span>customer records</span></div>
    <div class="stat" role="listitem"><b>${d.questions.length}</b><span>example questions</span></div>
  </div>

  <h2 class="sec">Documents it reads in the demo</h2>
  <p class="note">The paperwork in the ${esc(d.label.toLowerCase())} sample workspace, by type.</p>
  <ul class="chips">
${d.docTypes.map((t) => `    <li><b>${esc(t.label)}</b> · ${t.count}</li>`).join('\n')}
  </ul>

  <h2 class="sec" style="margin-top:36px">Questions to try</h2>
  <p class="note">Each answer below is what the demo returns from the sample records.</p>
  <ul class="qa">
${d.questions.map((q) => `    <li><div class="q">${esc(q.q)}</div><div class="a">${esc(q.answer)}</div>${q.source ? `<div class="src">Source: ${esc(q.source)}</div>` : ''}</li>`).join('\n')}
  </ul>

  <div class="cta">
    <h2>Ask it yourself</h2>
    <p>Open the ${esc(d.label.toLowerCase())} demo and ask these questions, or your own, against the sample records. The sample company and every record in it are made up. When you are ready, start with your own files: Solo has a 30-day free trial, card required, cancel anytime.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="${demoLink(d.slug)}">Try the ${esc(d.label.toLowerCase())} demo</a>
      <a class="btn btn-ghost" href="/app/?plan=solo&amp;interval=month">Start free trial</a>
    </div>
  </div>

  <h2 class="sec" style="margin-top:36px">More in ${esc(g.title.toLowerCase())}</h2>
  <ul class="related">
${related.map((r) => `    <li><a href="/industries/${pageFile(r.slug)}">${esc(r.label)}</a></li>`).join('\n')}
  </ul>

  <a class="back-home" href="/industries/">&larr; All industries</a>
</main>`;
  return page({ title, description, canonicalPath: `/industries/${d.slug}.html`, body });
}

export function renderHub(data) {
  const all = data.industries;
  const n = all.length;
  const description = `DeepWell works with the paperwork of ${n} kinds of business. Pick yours, see the documents and questions in its sample workspace, and try the demo.`;
  const groups = GROUPS.map((g) => {
    const items = g.slugs.map((s) => all.find((x) => x.slug === s)).filter(Boolean);
    return `  <section class="hub-group" data-group="${g.id}" aria-labelledby="g-${g.id}">
    <h2 id="g-${g.id}">${esc(g.title)}</h2>
    <p>${esc(g.blurb)}</p>
    <ul class="hub-grid">
${items.map((d) => {
      const search = [d.label, d.company, g.title, ...d.docTypes.map((t) => t.label)].join(' ').toLowerCase();
      return `      <li class="hub-item" data-search="${esc(search)}"><div class="hub-card">
        <h3><a href="/industries/${pageFile(d.slug)}">${esc(d.label)}</a></h3>
        <p>${plural(d.documents, 'sample document', 'sample documents')} · ${plural(d.docTypes.length, 'type', 'types')}</p>
        <p>${esc(d.docTypes.slice(0, 3).map((t) => t.label).join(', '))}</p>
        <div class="row"><a href="/industries/${pageFile(d.slug)}">Read more</a><a class="go" href="${demoLink(d.slug)}">Try the demo</a></div>
      </div></li>`;
    }).join('\n')}
    </ul>
  </section>`;
  }).join('\n');
  const body = `<main class="wrap wide">
  <div class="hero-block">
    <div class="eyebrow">Who it&rsquo;s for · Industries</div>
    <h1>${n} kinds of business, one app</h1>
    <p class="lede">Every industry below has a sample workspace you can open without signing in. Pick yours to see the paperwork DeepWell reads there and the questions it answers, then try the demo.</p>
  </div>

  <div class="hub-tools">
    <label for="hub-q" class="eyebrow">Find your industry</label>
    <input id="hub-q" class="hub-search" type="search" placeholder="Search by industry or document, e.g. roofing or invoice" autocomplete="off">
    <div class="hub-filters" role="group" aria-label="Filter by group">
      <button type="button" data-filter="all" aria-pressed="true">All</button>
${GROUPS.map((g) => `      <button type="button" data-filter="${g.id}" aria-pressed="false">${esc(g.title)}</button>`).join('\n')}
    </div>
    <div class="hub-count" id="hub-count" aria-live="polite">Showing all ${n} industries</div>
  </div>

${groups}
  <div class="hub-empty" id="hub-empty">No industry matches that search. Try a shorter word, or clear the filter.</div>

  <section class="hub-group" id="guides" data-group="guides" aria-labelledby="g-guides">
    <h2 id="g-guides">More guides</h2>
    <ul class="hub-guides">
${EXTRA_GUIDES.map((e) => `      <li><a href="${e.href}"><b>${esc(e.title)}</b><span>${esc(e.note)}</span></a></li>`).join('\n')}
    </ul>
  </section>

  <p class="note">Sample workspaces use made-up companies and records. Nothing in them is real customer data.</p>
  <a class="back-home" href="/">&larr; Back to deepwelltechnology.com</a>
</main>
<script>
(function () {
  var q = document.getElementById('hub-q');
  var items = Array.prototype.slice.call(document.querySelectorAll('.hub-item'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.hub-group[data-group]'));
  var btns = Array.prototype.slice.call(document.querySelectorAll('.hub-filters button'));
  var count = document.getElementById('hub-count');
  var empty = document.getElementById('hub-empty');
  var active = 'all';
  function apply() {
    var term = (q.value || '').trim().toLowerCase();
    var shown = 0;
    items.forEach(function (li) {
      var g = li.closest('.hub-group').getAttribute('data-group');
      var ok = (active === 'all' || active === g) && (!term || li.getAttribute('data-search').indexOf(term) !== -1);
      li.hidden = !ok;
      if (ok) shown++;
    });
    groups.forEach(function (sec) {
      if (sec.id === 'guides') { sec.hidden = !(active === 'all' && !term); return; }
      sec.hidden = !sec.querySelector('.hub-item:not([hidden])');
    });
    empty.style.display = shown ? 'none' : 'block';
    count.textContent = shown === items.length ? 'Showing all ' + items.length + ' industries' : 'Showing ' + shown + ' of ' + items.length + ' industries';
  }
  q.addEventListener('input', apply);
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      active = b.getAttribute('data-filter');
      btns.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      apply();
    });
  });
  try { var pre = new URLSearchParams(location.search).get('q'); if (pre) { q.value = pre; apply(); } } catch (e) {}
})();
</script>`;
  return page({ title: 'Industries — DeepWell Technology', description, canonicalPath: '/industries/', body });
}

/** Everything the generator owns: path (relative to repo root) -> content. */
export function renderAll(data = loadData()) {
  const out = new Map();
  out.set('public/industries/index.html', renderHub(data));
  for (const d of data.industries) {
    if (EXISTING_PAGES[d.slug]) continue;
    out.set(`public/industries/${d.slug}.html`, renderIndustry(d, data.industries));
  }
  return out;
}

/** Sitemap entries for every industries page (hub + all 43 industries + the hand-written extras). */
export function sitemapUrls(data = loadData()) {
  const urls = [`${SITE}/industries/`];
  for (const d of data.industries) urls.push(`${SITE}/industries/${pageFile(d.slug)}`);
  return urls;
}
