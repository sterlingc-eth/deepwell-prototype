// Minifies scripts/support-widget/widget.src.js -> public/support/widget.js (target <= 14 KB). `--check` fails if stale.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { transformSync } from 'esbuild';
const src = new URL('./support-widget/widget.src.js', import.meta.url);
const out = new URL('../public/support/widget.js', import.meta.url);
const min = transformSync(readFileSync(src, 'utf8'), { minify: true, target: 'es2017', legalComments: 'none' }).code;
const banner = '/* DeepWell Help widget (round 28) - built from scripts/support-widget/widget.src.js by scripts/build-support-widget.mjs */\n';
const body = banner + min;
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== body) { console.error('public/support/widget.js is stale: run node scripts/build-support-widget.mjs'); process.exit(1); }
  console.log('widget.js is fresh'); process.exit(0);
}
writeFileSync(out, body);
console.log(`wrote public/support/widget.js (${Buffer.byteLength(body)} bytes)`);
