/**
 * dql/linkAddress.js - PURE: reads "who else is at <street address>" and "what happened at <street address> [in 2022]" (links family, link_address).
 * Lives outside the family because parse.js releases most questions that carry a street address; this shape is let through before that release.
 */
const STREET_SUFFIX = 'st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|cir|circle|ter|terrace|trl|trail|hwy|highway|loop|row|walk';
export const ADDR_RE = new RegExp(`\\b(\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9.'-]+\\s+){0,3}?(?:${STREET_SUFFIX})\\b\\.?)`, 'i');
const SUFFIX_NORM = { street: 'st', avenue: 'ave', road: 'rd', boulevard: 'blvd', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl', parkway: 'pkwy', circle: 'cir', terrace: 'ter', trail: 'trl', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w' };
export function streetKey(addr) {
  const first = String(addr ?? '').split(',')[0];
  const noUnit = first.replace(/\b(?:apt|apartment|unit|suite|ste|bldg|building|#)\s*[\w-]+/ig, ' ');
  return noUnit.toLowerCase().replace(/[.']/g, '').split(/[^a-z0-9]+/).filter(Boolean).map((w) => SUFFIX_NORM[w] ?? w).join(' ');
}

export function parseAddress(raw, today) {
  const m = ADDR_RE.exec(String(raw ?? ''));
  if (!m) return null;
  const key = streetKey(m[1]);
  const cleanQ = String(raw).replace(m[1], ' ').toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let year = null;
  let q = cleanQ;
  const ym = /\bin (19\d\d|20\d\d)\b/.exec(q);
  if (ym) { year = Number(ym[1]); q = q.replace(ym[0], ' '); }
  const ly = /\b(last|this) year\b/.exec(q);
  if (ly) { year = Number(today.slice(0, 4)) - (ly[1] === 'last' ? 1 : 0); q = q.replace(ly[0], ' '); }
  q = q.replace(/\s+/g, ' ').trim();
  if (/^(?:who else (?:is|lives|are|works|rents|is there|has|have)(?: at| on| in)?|who(?:s| is| are)? (?:else )?(?:at|on|in|living at|located at)|anyone else (?:at|on|is at|lives at)|who else|any(?:one| other (?:customers?|clients?|tenants?|people)) (?:else )?(?:at|on)|(?:which|what) (?:other )?(?:customers?|clients?|tenants?|people|accounts?) (?:are |is |live |lives )?(?:at|on)|(?:list|show|give me|name) (?:everyone|everybody|all (?:customers?|clients?|tenants?|people)) (?:at|on)|who (?:else )?(?:is )?(?:also )?(?:at|on))(?: the)?(?: same)?(?: address| place| building| location| property)?$/.test(q)) {
    if (year) return null;
    return { op: 'link_address', mode: 'people', key, display: m[1].replace(/\s+/g, ' ').trim(), year: null };
  }
  if (/^(?:what happened|what went on|what was going on|what s happened|everything that happened|everything that went on|all activity|all the activity|what activity|what has happened|what did we do|what work (?:was|got) done|what (?:has|have) we done|history|the history|show the history|give me the history)(?: of| for)?(?: at| on)?(?: the)?(?: address| place| building| location| property)?$/.test(q)) {
    return { op: 'link_address', mode: 'story', key, display: m[1].replace(/\s+/g, ' ').trim(), year };
  }
  return null;
}

