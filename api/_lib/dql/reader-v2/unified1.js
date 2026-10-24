/** unified1.js - the unified rulebook switch (lane unified, 2026-10-22). ONE env switch, default OFF:
 *   DONOVAN_READER_V2_UNIFIED=1   turns on, on top of the round-350 reader (app 1.4.1 code = loop app_parity):
 *     alias_compound_v1 (doctypealias1.js), stem_fix_v1 (reader.js stemT), anydoc2_v1 (anydoc.js; industry-pack companies only: buildIndex(..., { pack: true })),
 *     determinism_v1 canon 'best' (doctype.js tokCanon: smallest exact OSA distance wins, ties by sorted order).
 * OFF = the previous behaviour byte for byte (nothing below is consulted). Same rulebook as the training loop's patches_ready/unified_v1 recipe profile. */
import fs from 'node:fs';
import path from 'node:path';
const truthy = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? '').trim());
export const U = { on: false };
export const RULES = { alias_compound_v1: { on: true, head_only: true, compound: true, alias: true }, stem_fix_v1: true, anydoc2_v1: { on: true } };
/** read the env once per configureFromBundle (loadReaderV2); returns the state */
export function configureUnified() { U.on = truthy(process.env.DONOVAN_READER_V2_UNIFIED); return U.on; }
export const unifiedOn = () => U.on;
/** v003 weights ride the same switch: data/v3.<name> is used instead of data/<name> only while DONOVAN_READER_V2_UNIFIED is on (OFF = today's v002 files, untouched). */
export function dataPath(dir, f) {
  if (truthy(process.env.DONOVAN_READER_V2_UNIFIED)) { const p = path.join(dir, 'v3.' + f); if (fs.existsSync(p)) return p; }
  return path.join(dir, f);
}
