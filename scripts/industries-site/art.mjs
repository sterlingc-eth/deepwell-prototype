// Industry hero art: one shared motion vocabulary (art.css + art.js) + one theme per industry (themes.json) + one glyph per industry (glyphs.mjs).
// Pure SVG/CSS/vanilla JS. All words and numbers on the stage come from data.json (the demo fixtures); nothing is invented here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLYPHS, renderGlyph } from './glyphs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const THEMES = JSON.parse(fs.readFileSync(path.join(HERE, 'themes.json'), 'utf8')).themes;
export const ART_CSS = fs.readFileSync(path.join(HERE, 'art.css'), 'utf8').trim() + '\n';
export const ART_JS = fs.readFileSync(path.join(HERE, 'art.js'), 'utf8').trim() + '\n';
export const ART_CSS_PATH = 'public/industries/ia.css';
export const ART_JS_PATH = 'public/industries/ia.js';
export const CHOREOS = ['draw', 'light', 'pop', 'stack', 'fill', 'scan', 'merge', 'drift', 'orbit', 'wave', 'stamp', 'sweep'];
export const BACKDROPS = ['grid', 'dots', 'hatch', 'ledger', 'rings', 'waves', 'rays', 'topo', 'circuit', 'tiles'];
export const STAGE_BUDGET_BYTES = 35 * 1024;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
export const palette = (t) => ({ a: hsl(t.hue, 56, 68), b: hsl(t.hue2, 62, 64), bg: hsl(t.hue, 30, 9), sf: hsl(t.hue, 24, 14), ln: hsl(t.hue, 22, 30) });
export const paletteKey = (t) => { const p = palette(t); return `${p.a}/${p.b}`; };

/** Hand-written pages that get the stage too (file under public/industries, theme key). */
export const HANDWRITTEN = [
  ['hvac.html', 'plumbing-hvac'], ['electrical.html', 'electrical'], ['property-management.html', 'property-management'],
  ['contractors.html', 'general-contractor'], ['nonprofits.html', 'nonprofit'], ['plumbing.html', 'plumbing'],
  ['offices.html', 'offices'], ['any-business.html', 'any-business'], ['fleet-equipment-rental.html', 'fleet-equipment-rental'],
];

// ---- backdrops (400x250 art box; glyph sits right of centre) ----
function backdrop(kind) {
  const W = 400, H = 300, cx = 296, cy = 150;
  if (kind === 'grid') return `<path d="${Array.from({ length: 19 }, (_, i) => `M${(i + 1) * 20} 0V${H}`).join('')}${Array.from({ length: 14 }, (_, i) => `M0 ${(i + 1) * 20}H${W}`).join('')}" stroke-width=".6" opacity=".16"/><path d="M100 0V300M200 0V300M300 0V300M0 100H400M0 200H400" stroke-width="1" opacity=".22"/>`;
  if (kind === 'dots') return `<path d="${Array.from({ length: 19 }, (_, r) => Array.from({ length: 25 }, (_, c) => `M${8 + c * 16} ${8 + r * 16}h.1`).join('')).join('')}" stroke-width="2.4" stroke-linecap="round" opacity=".3"/>`;
  if (kind === 'hatch') return `<path d="${Array.from({ length: 36 }, (_, i) => `M${i * 14 - 100} ${H}L${i * 14 + 150} 0`).join('')}" stroke-width=".8" opacity=".17"/>`;
  if (kind === 'ledger') return `<path d="${Array.from({ length: 13 }, (_, i) => `M0 ${30 + i * 22}H${W}`).join('')}" stroke-width=".8" opacity=".2"/><path d="M24 0V300" stroke="var(--b)" stroke-width="1" opacity=".4"/>`;
  if (kind === 'rings') return Array.from({ length: 8 }, (_, i) => `<circle cx="${cx}" cy="${cy}" r="${34 + i * 28}" stroke-width=".8" opacity="${(0.34 - i * 0.03).toFixed(2)}"/>`).join('');
  if (kind === 'waves') return Array.from({ length: 9 }, (_, i) => `<path class="bdw" d="M-40 ${40 + i * 28}q20-10 40 0t40 0t40 0t40 0t40 0t40 0t40 0t40 0t40 0t40 0t40 0" stroke-width="1" opacity=".22" style="--i:${i}"/>`).join('');
  if (kind === 'rays') return `<path d="${Array.from({ length: 28 }, (_, i) => { const a = (i / 28) * Math.PI * 2; return `M${cx} ${cy}L${(cx + Math.cos(a) * 420).toFixed(0)} ${(cy + Math.sin(a) * 420).toFixed(0)}`; }).join('')}" stroke-width=".7" opacity=".14"/>`;
  if (kind === 'topo') return Array.from({ length: 7 }, (_, i) => { const r = 30 + i * 26; return `<path d="M${cx - r} ${cy}c0-${r * 0.7} ${r * 0.5}-${r} ${r}-${r * 0.9}s${r * 0.9} ${r * 0.5} ${r * 0.7} ${r}-${r * 0.2} ${r * 0.8}-${r * 0.9} ${r * 0.9}-${r * 0.9}-${r * 0.2}-${r * 0.8}-${r * 0.7}Z" stroke-width=".8" opacity="${(0.34 - i * 0.034).toFixed(2)}"/>`; }).join('');
  if (kind === 'circuit') return `<path d="M0 40H120L140 60H230M0 90H80L100 110H180M0 200H90L110 180H200M400 30H330L310 50M400 260H340L320 240H260M180 0V30L200 50M230 300V270L250 250" stroke-width="1" opacity=".26"/><path d="M120 40h.1M230 60h.1M180 110h.1M200 180h.1M310 50h.1M260 200h.1M200 50h.1" stroke="var(--b)" stroke-width="5" stroke-linecap="round" opacity=".5"/>`;
  if (kind === 'tiles') return `<path d="${Array.from({ length: 10 }, (_, r) => `M0 ${r * 30 + 10}H${W}`).join('')}${Array.from({ length: 10 }, (_, r) => Array.from({ length: 11 }, (_, c) => `M${c * 40 + (r % 2 ? 20 : 0)} ${r * 30 + 10}v30`).join('')).join('')}" stroke-width=".7" opacity=".17"/>`;
  return '';
}

// ---- story: pick the question, the documents and the source from the demo data ----
const AGG = /\b(across|how many|all|total of|every|combined)\b/i;
export function pickStory(d) {
  const withSrc = d.questions.filter((q) => q.source);
  const single = withSrc.filter((q) => !AGG.test(q.q) && !/^what'?s the total on\b/i.test(q.q) && q.answer.length <= 90);
  const total = withSrc.filter((q) => /^what'?s the total on\b/i.test(q.q));
  const q = single.find((x) => !/^when was\b/i.test(x.q)) ?? single[0] ?? total[0] ?? withSrc[0] ?? d.questions[0];
  const src = (q.source || '').toLowerCase();
  const first = d.docTypes.find((t) => src.startsWith(t.label.toLowerCase()));
  const docs = [first, ...d.docTypes.filter((t) => t !== first)].filter(Boolean).slice(0, 3).map((t) => t.label);
  return { q: q.q, a: q.answer, s: q.source, docs };
}

const flowPaths = (n) => Array.from({ length: n }, (_, i) => { const y = Math.round((0.19 + 0.31 * i) * 300); return `<path class="ia-flow" style="--n:${i}" d="M164 ${y}C192 ${y} 192 150 214 150" fill="none"/>`; }).join('');

/** The stage for one industry. d = its data.json entry (or the demo workspace it borrows from); opts.demo = demo slug for the deep link. */
export function stageHtml(slug, d, opts = {}) {
  const t = THEMES[slug];
  if (!t) throw new Error('no theme for ' + slug);
  const p = palette(t);
  const st = pickStory(d);
  const label = t.label || d.label;
  const style = `--a:${p.a};--b:${p.b};--bg:${p.bg};--sf:${p.sf};--ln:${p.ln}`;
  const chips = st.docs.map((x, i) => `<div class="ia-chip" style="--n:${i}"><b>${esc(x)}</b><i></i><i class="s"></i></div>`).join('');
  const alt = `Example from the ${d.label.toLowerCase()} sample workspace (${d.company}, a made-up company). Documents read: ${st.docs.join(', ')}. Question: ${st.q} Answer: ${st.a}${st.s ? ` Source: ${st.s}.` : ''}`;
  const demo = opts.demo ? `<a class="ia-demo" href="/demo/?industry=${encodeURIComponent(opts.demo)}">Ask it in the demo &rarr;</a>` : '';
  return `<!--ia-hero--><section class="ia-stage" data-scene="${esc(t.scene)}" data-ch="${t.ch}" data-bd="${t.bd}" style="${style}" role="group" aria-label="${esc(alt)}">
  <div class="ia-head"><span class="ia-kicker">${esc(label)} &middot; example</span><button class="ia-pb" type="button" aria-pressed="false" aria-label="Pause the animation">Pause</button></div>
  <div class="ia-body">
    <div class="ia-art" aria-hidden="true">
      <svg viewBox="0 0 400 300" focusable="false" aria-hidden="true"><defs><radialGradient id="ia-gl" cx="74%" cy="50%" r="46%"><stop class="g0" offset="0"/><stop class="g1" offset="1"/></radialGradient></defs><rect width="400" height="300" fill="url(#ia-gl)"/><g class="ia-bd" fill="none" stroke="var(--a)">${backdrop(t.bd)}</g><g class="ia-flows" stroke="var(--b)">${flowPaths(st.docs.length)}</g><g class="ia-glyph" transform="translate(196 50) scale(2)">${renderGlyph(t.glyph)}</g><rect class="ia-scan" x="200" y="40" width="10" height="220" rx="5"/></svg>
      ${chips}
    </div>
    <div class="ia-qa">
      <p class="ia-q"><span class="ia-who">Ask</span><span class="ia-qt">${esc(st.q)}</span></p>
      <p class="ia-a"><span class="ia-who">Answer</span><span>${esc(st.a)}</span></p>
      ${st.s ? `<p class="ia-s"><span class="ia-who">Source</span><span>${esc(st.s)}</span></p>` : ''}
      <p class="ia-ft">Example records from the ${esc(d.label.toLowerCase())} sample workspace (${esc(d.company)}, a made-up company).${demo ? ' ' + demo : ''}</p>
    </div>
  </div>
</section><script>(function(){var s=document.currentScript.previousElementSibling;if(s&&window.IntersectionObserver&&!matchMedia('(prefers-reduced-motion: reduce)').matches){s.classList.add('ia-arm');setTimeout(function(){if(!s.__ia)s.classList.remove('ia-arm')},4000)}})()</script><!--/ia-hero-->`;
}

export const headLink = '<link rel="stylesheet" href="/industries/ia.css">';
export const bodyScript = '<script defer src="/industries/ia.js"></script>';

/** Small themed mark for hub cards. */
export function iconHtml(slug) {
  const t = THEMES[slug];
  if (!t) return '';
  const p = palette(t);
  return `<svg class="ia-ic" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="--a:${p.a};--b:${p.b}">${renderGlyph(t.glyph, true)}</svg>`;
}

function closeOf(html, start, open = /<div\b/g) {
  let depth = 0;
  const re = /<div\b|<\/div>/g; re.lastIndex = start;
  for (let m; (m = re.exec(html)); ) { depth += m[0] === '</div>' ? -1 : 1; if (depth === 0) return m.index + 6; }
  return -1;
}
/** Insert (or refresh, idempotently) the stage after the hero block of a page, plus the css link and script. Returns the new html, or null when no hero block. */
export function injectStage(html, stage) {
  let out = html.replace(/\n\n  <!--ia-hero-->[\s\S]*?<!--\/ia-hero-->/, '').replace(/<!--ia-hero-->[\s\S]*?<!--\/ia-hero-->/, '');
  const hb = out.indexOf('<div class="hero-block"');
  if (hb < 0) return null;
  const end = closeOf(out, hb);
  if (end < 0) return null;
  out = out.slice(0, end) + '\n\n  ' + stage + out.slice(end);
  if (!out.includes('href="/industries/ia.css"')) out = out.replace('</head>', headLink + '\n</head>');
  if (!out.includes('src="/industries/ia.js"')) out = out.replace('</body>', bodyScript + '\n</body>');
  return out;
}

export function artFiles() { return new Map([[ART_CSS_PATH, ART_CSS], [ART_JS_PATH, ART_JS]]); }
export { ROOT as ART_ROOT, GLYPHS };
