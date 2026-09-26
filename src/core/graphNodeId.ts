import type { Entity } from './types';

const STREET_SUFFIX = '(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|pkwy|parkway|hwy|highway)';
const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const ADDR_HEAD_RE = new RegExp(`(\\d{1,6})\\s+((?:[A-Za-z0-9.']+\\s+){0,4}?[A-Za-z0-9.']+?)\\s+${STREET_SUFFIX}\\b`, 'i');
const UNIT_NUMERIC_RE = /\b(?:apt|apartment|suite|ste|unit|no|number)\.?\s*#?\s*(\d+[A-Za-z]?)\b/i;
const UNIT_ALPHA_RE = /\b(?:apt|apartment|suite|ste)\.?\s*#?\s*([A-Za-z])\b/i;
const UNIT_HASH_RE = /#\s*(\d+[A-Za-z]?)\b/;

function slugCity(city: string | null): string | null {
  return String(city ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

/**
 * Best-effort mirror of the backend's site-node key (api/_lib/financials/jobKey.js's
 * normalizeJobKey, reused by api/_lib/graph/build.js's siteKeyFromAddress): house number + up
 * to 2 significant street words + unit designator + city, lower-cased and hyphenated — the same
 * shape so a property entity synced from the same address agrees with the backend's own site
 * node id. Deliberately DUPLICATED here rather than imported from api/_lib (this frontend bundle
 * has no existing import from that tree — see this repo's other services/*Client.ts files, which
 * all talk to api/_lib over HTTP, never by importing its code); kept small and pure so the two
 * are easy to keep in sync by eye. Returns null when the address doesn't parse as a street
 * address at all — never guessed, same rule the backend version follows.
 */
export function siteKeyFromPropertyFields(address: string | null | undefined, city: string | null | undefined): string | null {
  const text = String(address ?? '');
  const m = ADDR_HEAD_RE.exec(text);
  const house = m?.[1];
  const streetWords = m?.[2];
  if (!house || !streetWords) return null;
  const words = streetWords
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[.']/g, ''))
    .filter((w) => w && !DIRECTIONALS.has(w));
  if (!words.length) return null;
  const unit = (UNIT_NUMERIC_RE.exec(text) ?? UNIT_ALPHA_RE.exec(text) ?? UNIT_HASH_RE.exec(text))?.[1]?.toLowerCase() ?? null;
  const core = `${house}-${words.slice(0, 2).join('-')}${unit ? `-u${unit}` : ''}`;
  const locality = slugCity(city ?? null);
  return locality ? `${core}-${locality}` : core;
}

/**
 * Maps a local entity-graph record to the node id the Knowledge Graph API
 * contract uses for that record ('customer:<uuid>', 'unit:<uuid>',
 * 'site:<address key>', 'tech:<name>', 'visit:<uuid>') — so a Graph entry
 * point (CustomerProfileScreen, EntityScreen) can seed the view with the
 * same id the backend already knows this record by, instead of reinventing
 * one. `technician` is keyed by name (the contract's 'tech:<name>' form);
 * `property` is keyed by its own canonical address (siteKeyFromPropertyFields
 * above — a site node is NOT keyed by uuid on the backend, so this is the
 * one case that isn't just `${prefix}:${entity.id}`); everything else uses
 * the local record id, which is the closest thing this frontend has to the
 * backend's own key for it — including `service` (a visit is keyed by its
 * source document's own uuid on the backend, which is what a real synced
 * 'service' entity's id will be once that sync exists; see usePostgresSync.ts's
 * own header for why it doesn't yet).
 *
 * Kept in its own module (not KnowledgeGraph.tsx) purely so that component
 * file only exports the component — oxlint's react-refresh rule flags a
 * file that exports both, and every other component in src/components/
 * follows the same split (see StagePill.tsx/WarrantyStatusBadge.tsx).
 */
export function entityNodeId(entity: Pick<Entity, 'id' | 'type' | 'fields'>): string | null {
  switch (entity.type) {
    case 'equipment':
      return `unit:${entity.id}`;
    case 'property': {
      const address = typeof entity.fields.address === 'string' ? entity.fields.address : null;
      const city = typeof entity.fields.city === 'string' ? entity.fields.city : null;
      const key = siteKeyFromPropertyFields(address, city);
      return key ? `site:${key}` : null;
    }
    case 'service':
      return `visit:${entity.id}`;
    case 'technician': {
      const name = typeof entity.fields.name === 'string' && entity.fields.name.trim() ? entity.fields.name : entity.id;
      return `tech:${name}`;
    }
    case 'customer':
      return `customer:${entity.id}`;
    default:
      return null;
  }
}

export function customerNodeId(customerId: string): string {
  return `customer:${customerId}`;
}
