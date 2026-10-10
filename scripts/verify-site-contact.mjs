/** Every Contact / Talk to us link on every public page resolves to a real target; the home "talk-demo" section exists. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && x ? '  -> ' + x : ''}`); };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (['samples', 'founders', 'support', 'm'].includes(e.name) ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.html') ? [path.join(d, e.name)] : []);
const files = [path.join(ROOT, 'index.html'), ...walk(path.join(ROOT, 'public'))];
const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const homeIds = new Set([...home.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const allowedMail = new Set([...home.matchAll(/mailto:([^?"']+)/g)].map((m) => m[1]));
const redirect = (f) => /Redirecting to/.test(fs.readFileSync(f, 'utf8'));
let total = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f), html = fs.readFileSync(f, 'utf8');
  if (redirect(f)) continue;
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>\s*(Contact|Talk to us)\s*<\/a>/gi)].map((m) => m[1]);
  check(`${rel}: has a Contact or Talk to us link`, links.length > 0);
  for (const href of links) {
    total++;
    if (href.startsWith('mailto:')) { check(`${rel}: ${href} uses a known site address`, allowedMail.has(href.slice(7).split('?')[0])); continue; }
    const m = href.match(/^(\/?)#(.+)$/) || href.match(/^\/#(.+)$/);
    if (rel === 'index.html') check(`${rel}: ${href} target exists`, /^#/.test(href) && homeIds.has(href.slice(1)));
    else check(`${rel}: ${href} points at the home contact section`, href === '/#contact' && homeIds.has('contact'));
  }
}
check('home has the contact form (inq-form) and #contact', homeIds.has('contact') && homeIds.has('inq-form'));
check('home nav has a Contact link', /<div class="navlinks"[\s\S]*?<a href="#contact">Contact<\/a>[\s\S]*?<\/div>\s*<div class="navcta"/.test(home));
const i = home.indexOf('<section id="talk-demo"');
check('home has the talk-demo section', i > -1);
const sec = i > -1 ? home.slice(i, home.indexOf('</section>', i)) : '';
check('talk-demo appears before the contact form', i > -1 && i < home.indexOf('id="inq-form"'));
check('talk-demo respects prefers-reduced-motion', /prefers-reduced-motion/.test(sec) && /matchMedia/.test(sec));
check('talk-demo has the three steps', ['td-s1', 'td-s2', 'td-s3'].every((s) => sec.includes(s)));
check('talk-demo links to #contact', sec.includes('href="#contact"'));
check('talk-demo says the data is made up', /made up/.test(sec));
console.log(`\n${pass} passed, ${fail} failed (${total} contact links checked)`);
process.exit(fail ? 1 : 0);
