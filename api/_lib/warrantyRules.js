/**
 * Warranty derivation: turning what a page said into what someone needs to do.
 *
 * Why this is a separate file and not part of extraction: extraction is
 * forbidden from calculating. `extractFields.js` tells the model in as many
 * words not to work out an expiry from a term and an install date, because a
 * computed date rendered next to a citation is the worst failure this product
 * has — it looks like something a document said when it isn't. So extraction
 * returns only what is printed, and arithmetic happens here, clearly labelled,
 * and is stored on the equipment entity rather than in `extractions`.
 *
 * The rule that matters to the customer:
 *
 *   An HVAC unit gets a short parts warranty by default and a much longer one
 *   if it is REGISTERED with the manufacturer within a short window after
 *   installation. Goodman and Trane both publish 60 days, 5 years unregistered,
 *   10 years registered. Miss the window and the homeowner silently loses five
 *   years of coverage, and the contractor eats the callback in year seven.
 *
 * Nobody currently tracks that window. It starts the day the unit is installed,
 * which is a date that appears on the install paperwork — so the moment that
 * paperwork is ingested, the countdown is knowable. That is the whole feature.
 *
 * HONESTY RULES BAKED IN HERE:
 *   1. A printed expiry always beats a computed one. If a page states the date,
 *      that is the answer and `basis` says 'printed'.
 *   2. An unverified brand produces NO deadline and NO computed expiry. A wrong
 *      deadline is worse than no deadline: it tells someone they have time when
 *      they don't, or sends them chasing a window that already closed.
 *   3. "No registration on file" is never reported as "not registered". We know
 *      what our documents say, not what somebody did on a portal. The wording
 *      matters because the action is different — one is "check", not "you lost
 *      five years".
 *   4. A registered term that depends on a fact this system doesn't collect —
 *      which coverage option the homeowner elected, whether they're still the
 *      original owner, whether the model qualifies, whether the home is
 *      owner-occupied — is never guessed. It computes the manufacturer's
 *      guaranteed floor (every one of these brands confirms at least that much
 *      no matter how the unknown fact resolves) and says in a note what would
 *      need confirming to possibly do better. A floor is a certain fact, not a
 *      guess, which is why this is different from rule #2: the brand IS
 *      verified, the arithmetic just has an honest ceiling on how far it can go
 *      without more information.
 */

/**
 * Manufacturer rules.
 *
 * `verified` is the date a human (or this session) read the manufacturer's own
 * published warranty page, with the URL that was read. An entry with
 * `rule: null` means we RECOGNISE the brand but have not confirmed its terms —
 * it is listed deliberately so the gap is visible and countable rather than
 * looking like the brand was never considered.
 *
 * Do not fill one of these in from a blog, a distributor, or a summary site.
 * Manufacturer page or nothing — except where `confidence: 'medium'` says the
 * best available page was one step removed from the brand itself (a shared
 * certificate, a carried-over figure), which is disclosed rather than hidden.
 *
 * A `rule` is one of:
 *   - `{ registrationWindowDays, unregisteredPartsYears, registeredPartsYears }`
 *     — registering always earns the same term. `registeredPartsYears` is a
 *     plain number.
 *   - the same shape but `registeredPartsYears: null` plus
 *     `conditionalRegisteredTerms: [{ years, factKey, factValue, description }]`
 *     — the extended term depends on a fact this system has no field for.
 *     `unregisteredPartsYears` is still the guaranteed floor once registered,
 *     because every brand modelled this way confirms at least that much
 *     regardless of how the unknown fact resolves. `factKey`/`factValue` let
 *     `deriveWarranty` resolve the term with certainty IF `facts` ever carries
 *     that key — nothing in extraction populates one today, so in practice
 *     this always falls through to the floor, honestly, rather than guessing.
 *
 * `caveats` are brand-level facts that don't change the arithmetic but change
 * what a human should do with the number: a jurisdiction that overrides it, a
 * product line the rule doesn't cover, a citation that's one step removed from
 * the brand. They're surfaced in `notes` on every derivation for that brand.
 */
export const BRAND_RULES = {
  goodman: {
    label: 'Goodman',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.goodmanmfg.com/resources/hvac-learning-center/warranty/the-air-conditioner-limited-warranty---the-why-when-how',
    aliases: ['goodman global'],
  },
  trane: {
    label: 'Trane',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.trane.com/residential/en/resources/warranty-and-registration/',
    aliases: ['trane technologies'],
  },

  // ---- siblings of the two above, verified independently. Warranty terms are
  // a per-brand marketing decision, not something a parent company shares
  // automatically, so these were read on their own pages rather than copied
  // from Goodman's/Trane's — see the tests that guard against exactly that
  // shortcut ("sibling brands are independently verified, not aliased").
  amana: {
    label: 'Amana',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.amana-hac.com/support/warranty',
  },
  'american standard': {
    label: 'American Standard',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.americanstandardair.com/support/warranty/',
  },

  lennox: {
    label: 'Lennox',
    // Merit/Elite lines only — see caveats.
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.lennox.com/why-lennox/warranty',
    aliases: ['lennox industries'],
    caveats: [
      'CA, FL, GA, and Quebec grant the 10-year registered term automatically ' +
        'regardless of registration. We have no reliable jurisdiction signal to ' +
        'act on this, so it is not applied — actual coverage in those places may ' +
        'be better than what is computed here, never worse.',
      'The Signature line publishes different terms (10-year base, 12-year ' +
        'registered) at medium confidence. That is not modelled here — this rule ' +
        'is Merit/Elite only. A Signature unit should be confirmed separately.',
    ],
  },

  // ---- 90-day window, 5/10 base, extended term gated on a fact we don't
  // collect. See `conditionalRegisteredTerms` above for how that's resolved.
  carrier: {
    label: 'Carrier',
    rule: {
      registrationWindowDays: 90,
      unregisteredPartsYears: 5,
      registeredPartsYears: null,
      conditionalRegisteredTerms: [
        {
          years: 10,
          factKey: 'warranty_coverage_election',
          factValue: 'parts10',
          description: 'the homeowner elected 10-year parts at registration',
        },
        {
          years: 5,
          factKey: 'warranty_coverage_election',
          factValue: 'parts5_labor3',
          description: 'the homeowner elected 5-year parts + 3-year labor at registration',
        },
      ],
    },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.carrier.com/residential/en/us/warranty/',
    aliases: ['carrier global'],
  },
  payne: {
    label: 'Payne',
    // Same certificate as Carrier's (hosted on Carrier's CDN), corroborated
    // independently by payne.com, so the same registration-choice condition
    // applies — it would be inconsistent to treat Carrier's term as uncertain
    // and Payne's as settled off the same document.
    rule: {
      registrationWindowDays: 90,
      unregisteredPartsYears: 5,
      registeredPartsYears: null,
      conditionalRegisteredTerms: [
        {
          years: 10,
          factKey: 'warranty_coverage_election',
          factValue: 'parts10',
          description: 'the homeowner elected 10-year parts at registration',
        },
        {
          years: 5,
          factKey: 'warranty_coverage_election',
          factValue: 'parts5_labor3',
          description: 'the homeowner elected 5-year parts + 3-year labor at registration',
        },
      ],
    },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.payne.com/warranty',
    caveats: [
      "Certificate is Carrier's, re-hosted on Carrier's CDN and corroborated by payne.com.",
    ],
  },
  bryant: {
    label: 'Bryant',
    rule: {
      registrationWindowDays: 90,
      unregisteredPartsYears: 5,
      registeredPartsYears: null,
      conditionalRegisteredTerms: [
        {
          years: 10,
          factKey: 'original_owner',
          factValue: true,
          description: 'the homeowner registering is still the original owner',
        },
      ],
    },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.bryant.com/en/us/support/warranty/',
    caveats: ['A subsequent (non-original) owner is capped at the 5-year floor regardless of registration.'],
  },

  // ---- Rheem/Ruud: same 90/5/10 shape, but the 10-year tier is model-
  // dependent rather than universal, so it is gated the same way as Carrier's
  // election and Bryant's ownership — a fact we have no field for.
  rheem: {
    label: 'Rheem',
    rule: {
      registrationWindowDays: 90,
      unregisteredPartsYears: 5,
      registeredPartsYears: null,
      conditionalRegisteredTerms: [
        {
          years: 10,
          factKey: 'model_qualifies_extended_warranty',
          factValue: true,
          description: 'the registered model qualifies for the 10-year tier',
        },
      ],
    },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.rheem.com/warranty/',
  },
  ruud: {
    label: 'Ruud',
    rule: {
      registrationWindowDays: 90,
      unregisteredPartsYears: 5,
      registeredPartsYears: null,
      conditionalRegisteredTerms: [
        {
          years: 10,
          factKey: 'model_qualifies_extended_warranty',
          factValue: true,
          description: 'the registered model qualifies for the 10-year tier',
        },
      ],
    },
    confidence: 'medium',
    verified: '2026-09-16',
    source: 'https://www.ruud.com/warranty/',
    caveats: [
      "The 90-day registration window is carried over from Rheem's certificate " +
        '— it is not independently restated on a Ruud-specific page. Treat the ' +
        'window itself, not just the 10-year tier, as the less-certain figure here.',
    ],
  },

  daikin: {
    label: 'Daikin',
    rule: {
      registrationWindowDays: 60,
      unregisteredPartsYears: 5,
      registeredPartsYears: null,
      conditionalRegisteredTerms: [
        { years: 12, factKey: 'owner_occupied', factValue: true, description: 'the home is owner-occupied' },
        { years: 10, factKey: 'owner_occupied', factValue: false, description: 'the home is not owner-occupied' },
      ],
    },
    confidence: 'high',
    verified: '2026-09-16',
    source: 'https://www.daikincomfort.com/support/warranty',
    aliases: ['daikin applied', 'daikin comfort', 'daikin industries'],
    caveats: [
      'One entry-level Daikin line has no registration-extension option at all. ' +
        'If this unit is on that line, no term beyond the 5-year floor should be ' +
        'assumed even once occupancy is confirmed.',
    ],
  },

  // ---- ICP (Carrier-family) brands: one shared certificate shape (90-day
  // window, 5-year unregistered floor, 10-year registered, no election gate
  // unlike Carrier's own line). Heil and Tempstar were read directly; the
  // remaining ICP siblings publish the same certificate structure but were
  // not fetched individually this session — see docs/HVAC_WARRANTY_RESEARCH.md.
  heil: {
    label: 'Heil',
    rule: { registrationWindowDays: 90, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-19',
    source: 'https://www.heil-hvac.com/en/us/product-registration-warranty',
  },
  tempstar: {
    label: 'Tempstar',
    rule: { registrationWindowDays: 90, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-19',
    source: 'https://www.tempstar.com/en/us/product-registration-warranty',
  },
  comfortmaker: {
    label: 'Comfortmaker',
    rule: { registrationWindowDays: 90, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'medium',
    verified: '2026-09-19',
    source: 'https://www.comfortmaker.com/en/us/product-registration-warranty',
    caveats: ["Not independently fetched this session; ICP siblings (Heil, Tempstar) confirm the same certificate structure."],
  },
  'day and night': {
    label: 'Day & Night',
    rule: { registrationWindowDays: 90, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'medium',
    verified: '2026-09-19',
    source: 'https://www.dayandnight.com/en/us/product-registration-warranty',
    aliases: ['day night'],
    caveats: ["Not independently fetched this session; ICP siblings (Heil, Tempstar) confirm the same certificate structure."],
  },
  keeprite: {
    label: 'KeepRite',
    rule: { registrationWindowDays: 90, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'medium',
    verified: '2026-09-19',
    source: 'https://www.keeprite.com/en/us/product-registration-warranty',
    caveats: ["Not independently fetched this session; ICP siblings (Heil, Tempstar) confirm the same certificate structure."],
  },
  arcoaire: {
    label: 'Arcoaire',
    rule: { registrationWindowDays: 90, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'medium',
    verified: '2026-09-19',
    source: 'https://www.arcoaire.com/en/us/product-registration-warranty',
    caveats: ["Not independently fetched this session; ICP siblings (Heil, Tempstar) confirm the same certificate structure."],
  },

  // ---- Lennox-family "Allied Air" badge line: same 60/5/10 shape as Lennox
  // Merit/Elite, verified on each sibling's own page (Armstrong, AirEase) or
  // corroborated by them (Ducane's own page states the 60-day window and
  // 5-year floor but not the registered figure explicitly).
  armstrong: {
    label: 'Armstrong Air',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-19',
    source: 'https://www.armstrongair.com/buyers-guide/warranty/',
    aliases: ['armstrong air'],
    caveats: ['Heat exchanger warranty (20yr unregistered / lifetime registered) is not modeled — only the parts term.'],
  },
  airease: {
    label: 'AirEase',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-19',
    source: 'https://www.airease.com/planning/warranty/',
    caveats: ['Heat exchanger warranty (20yr unregistered / lifetime registered) is not modeled — only the parts term.'],
  },
  ducane: {
    label: 'Ducane',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'medium',
    verified: '2026-09-19',
    source: 'https://www.ducanehvac.com/owner-support/warranty-registration/',
    caveats: [
      "Ducane's own page states the 60-day window and 5-year unregistered floor but not the registered figure; " +
        '10 years is corroborated from sibling Allied Air brands (Armstrong Air, AirEase), not an exact quote from Ducane itself.',
    ],
  },

  // ---- Napoleon: cheap, low-volume residential brand. Clean 60/5/10 shape,
  // its own page, no family caveats.
  napoleon: {
    label: 'Napoleon',
    rule: { registrationWindowDays: 60, unregisteredPartsYears: 5, registeredPartsYears: 10 },
    confidence: 'high',
    verified: '2026-09-19',
    source: 'https://napoleonproducts.com/downloads/hvac/warranty/NAP%20MFG%20Warranty_AC_SEER_13_14_16_EN.pdf',
  },

  // ---- Mitsubishi Electric Trane HVAC US (METUS): 90-day window, 5-year
  // unregistered floor (7-year compressor, not modeled — this schema tracks
  // one parts term only). The registered ceiling depends on TWO facts we
  // don't collect (owner-occupied, AND Diamond/Ductless-Pro contractor tier
  // for the top 12-year figure) — modeled the same conservative way as
  // Daikin's single-fact gate, with the contractor-tier distinction disclosed
  // rather than guessed.
  mitsubishi: {
    label: 'Mitsubishi Electric',
    rule: {
      registrationWindowDays: 90,
      unregisteredPartsYears: 5,
      registeredPartsYears: null,
      conditionalRegisteredTerms: [
        {
          years: 10,
          factKey: 'owner_occupied',
          factValue: true,
          description:
            'the home is owner-occupied (a Diamond Contractor/Ductless Pro install may reach 12 years — that ' +
            'contractor-tier fact is not modeled; confirm separately)',
        },
      ],
    },
    confidence: 'medium',
    verified: '2026-09-19',
    source: 'https://www.acdirect.com/media/specs/Mitsubishi/mitsubishi-r454b-warranty.pdf',
    aliases: ['mitsubishi electric'],
    caveats: ['Source is a dealer-hosted copy of the manufacturer certificate, not fetched directly from mitsubishicomfort.com.'],
  },

  // ---- recognised, NOT yet verified. These deliberately compute nothing. ----
  // york/coleman/luxaire: as of 2026-09-19, york.com's warranty pages 302
  // redirect to a Bosch parent landing page (york.bosch-hcgroup.com) with no
  // terms reachable — same brand family, same gap.
  york: { label: 'York', rule: null },
  coleman: { label: 'Coleman', rule: null },
  luxaire: { label: 'Luxaire', rule: null },
  // fujitsu: fujitsugeneral.com's own AIRSTAGE warranty PDF states the terms
  // (5yr/7yr unregistered parts/compressor; 10yr registered; 12yr via Elite
  // contractor) but never states a registration DEADLINE in days — the one
  // number this schema needs to compute anything. See research doc.
  fujitsu: { label: 'Fujitsu', rule: null },
  // bosch: bosch-homecomfort.com states registration does NOT change parts
  // coverage (flat per its own FAQ) — this schema's registration-window shape
  // doesn't fit a brand where registering changes nothing about the parts
  // term. Modeling it would either invent a deadline that doesn't matter or
  // produce a "register to secure X years instead of X" message, which is
  // wrong. Left unmodeled rather than forced into the wrong shape.
  bosch: { label: 'Bosch', rule: null },
  // maytag: registered figure is stated (12yr, Nordyne/Nortek "M1200"/"M120"
  // lines) but the unregistered floor — the number this schema needs as its
  // guaranteed minimum — is not stated anywhere found.
  maytag: { label: 'Maytag', rule: null },
  // nordyne: umbrella/OEM name, not itself a product line with a published
  // consumer warranty page.
  nordyne: { label: 'Nordyne', rule: null },
};

/**
 * Corporate suffixes, stripped only from the END of the string, repeatedly.
 *
 * Only unambiguous legal-entity markers. Words like `group`, `holdings`,
 * `products`, `brands`, `global`, `industries`, `technologies`, `usa` and
 * `international` were removed after they turned "Goodman Group" — a real and
 * entirely unrelated property company — into a Goodman warranty deadline. Those
 * words are as often the actual second half of a company's name as they are a
 * suffix, and nothing in the string says which.
 *
 * `electric` and `hvac` are not here either, for the same reason: stripping
 * them turned "Goodman Electric", a plausible electrical contractor, into an
 * exact match. Where a brand genuinely contains such a word — Mitsubishi
 * Electric, Trane Technologies — it is listed as an explicit alias, which
 * distinguishes a real brand spelling from a business that merely ends the
 * same way.
 */
const CORP_SUFFIX =
  /\s+(inc|llc|corp|corporation|co|company|companies|mfg|mfr|manufacturing)$/;

/** A label printed before the value: "Manufacturer: Goodman". */
const LEADING_LABEL = /^(manufacturer|mfr|mfg|brand|make|oem)\s+/;

/** Every accepted spelling -> canonical key. */
const SPELLINGS = (() => {
  const map = new Map();
  for (const [key, v] of Object.entries(BRAND_RULES)) {
    map.set(key, key);
    for (const a of v.aliases ?? []) map.set(a, key);
  }
  return map;
})();

/**
 * Map whatever was printed on the paperwork to a rules key.
 *
 * The match must consume the WHOLE cleaned string. Not a substring, not a
 * prefix — the whole thing.
 *
 * Substring matching resolved "Sold by John Goodman" to Goodman. Prefix
 * matching fixed that and still resolved "Trane Certified Dealer" and "Trane
 * Comfort Specialist" — which are not contrived, they are printed on half the
 * contractor letterheads in the trade, on paperwork for whatever brand was
 * actually serviced that day. Every attempt to patch that with a list of
 * forbidden trailing words was whack-a-mole: parts, financing, warehouse,
 * certified, specialist, approved, and so on without end.
 *
 * So the rule is strict, and it fails in the safe direction. A brand written
 * last ("condenser, Trane") or buried in a model string now returns null and
 * computes nothing, which costs a reminder. A false positive costs a
 * confidently wrong warranty deadline on one of the only two brands where the
 * arithmetic actually runs. Those are not comparable, and this file's contract
 * already says which one is worse.
 *
 * If real paperwork turns out to put the brand somewhere this misses, the fix
 * is a new alias or a tightened extraction prompt — not a looser matcher.
 */
/**
 * Team G (industry packs): pack.id -> its own {spelling -> canonical key} map,
 * built from that pack's `warranty.brandRules` the same way SPELLINGS above is
 * built from the module-level BRAND_RULES. Cached per pack id. `null`/the hvac
 * pack itself returns SPELLINGS unchanged (object identity), so every existing
 * 1-arg caller of normalizeBrand/deriveWarranty is byte-for-byte unchanged.
 */
const packSpellingsCache = new Map();
function spellingsFor(pack) {
  if (!pack || pack.id === 'hvac') return SPELLINGS;
  const cached = packSpellingsCache.get(pack.id);
  if (cached) return cached;
  const map = new Map();
  for (const [key, v] of Object.entries(pack.warranty?.brandRules ?? {})) {
    map.set(key, key);
    for (const a of v.aliases ?? []) map.set(a, key);
  }
  packSpellingsCache.set(pack.id, map);
  return map;
}

/** This pack's own brand-rules table, or BRAND_RULES for hvac/no pack. */
export function brandRulesForPack(pack) {
  return pack && pack.id !== 'hvac' ? (pack.warranty?.brandRules ?? {}) : BRAND_RULES;
}

export function normalizeBrand(raw, pack = null) {
  let cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  cleaned = cleaned.replace(LEADING_LABEL, '').trim();

  // Repeatedly, so "Goodman Manufacturing Co" sheds both.
  for (let i = 0; i < 6; i++) {
    const next = cleaned.replace(CORP_SUFFIX, '').trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  if (!cleaned) return null;

  return spellingsFor(pack).get(cleaned) ?? null;
}

/** True only for a real calendar date in YYYY-MM-DD. Shape alone is not enough. */
/**
 * A real calendar date AND a plausible one.
 *
 * isValidYmd alone accepts '0100-01-01' and '9999-12-31', because they are
 * genuine dates. Both warranty routes accept a caller-supplied `today` and
 * their own comments say a malformed value must fail loudly rather than
 * silently produce nonsense urgency — but the guard only checked the calendar,
 * so `today: "1000-01-01"` came back as "Register with Goodman within 374131
 * day(s)". Bounded only where a CLOCK value is expected; an installation_date
 * from 1994 is legitimate and is not checked against this.
 */
export function isPlausibleToday(s) {
  if (!isValidYmd(s)) return false;
  const year = Number(String(s).slice(0, 4));
  return year >= 2000 && year <= 2100;
}

export function isValidYmd(s) {
  return parseYmd(s) !== null;
}

/* ----------------------------------------------------------------- date math */

/** Parse a strict YYYY-MM-DD into UTC parts, or null. Never `new Date(string)`. */
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = Date.UTC(y, mo - 1, d);
  const probe = new Date(t);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return t;
}

function toYmd(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const DAY = 86_400_000;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));

/**
 * Parse a printed date in one of several shapes extraction is known to
 * return, without ever inventing a day this system can't back.
 *
 * A maintenance agreement that says "installed 06/2021" gives extraction no
 * day to report — extraction correctly returns only what's printed (see the
 * module comment's HONESTY RULES), and this file was previously throwing that
 * whole fact away because `isValidYmd` only accepts YYYY-MM-DD. The unit then
 * showed "No warranty on file" even though it was, in fact, printed and
 * computable to the month.
 *
 * Accepted: `YYYY-MM-DD` (day precision), `YYYY-MM`, `MM/YYYY`,
 * `MM/DD/YYYY` (day precision), and `Month YYYY` / `Mon YYYY` (case-
 * insensitive, full or 3-letter month name). Every month-only shape is
 * anchored to the 1st with `precision: 'month'` — that day is an arithmetic
 * placeholder, never asserted as something the document said.
 *
 * @param {unknown} raw
 * @returns {{ymd: string, precision: 'day'|'month'}|null}
 */
export function normalizeDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  if (parseYmd(s) !== null) return { ymd: s, precision: 'day' };

  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) {
    const ymd = `${m[1]}-${m[2].padStart(2, '0')}-01`;
    return parseYmd(ymd) !== null ? { ymd, precision: 'month' } : null;
  }

  // MM/DD/YYYY before MM/YYYY — both start the same way, but this one has an
  // extra segment.
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const ymd = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return parseYmd(ymd) !== null ? { ymd, precision: 'day' } : null;
  }

  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const ymd = `${m[2]}-${m[1].padStart(2, '0')}-01`;
    return parseYmd(ymd) !== null ? { ymd, precision: 'month' } : null;
  }

  m = /^([a-zA-Z]+)\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const word = m[1].toLowerCase();
    const idx = MONTH_NAMES.indexOf(word) !== -1 ? MONTH_NAMES.indexOf(word) : MONTH_ABBR.indexOf(word.slice(0, 3));
    if (idx === -1) return null;
    const ymd = `${m[2]}-${String(idx + 1).padStart(2, '0')}-01`;
    return parseYmd(ymd) !== null ? { ymd, precision: 'month' } : null;
  }

  return null;
}

export function addDays(ymd, days) {
  const t = parseYmd(ymd);
  return t === null ? null : toYmd(t + days * DAY);
}

/**
 * Add whole years, clamping Feb 29 back to Feb 28 rather than rolling into
 * March. An install on a leap day should not report an anniversary a day late
 * for the rest of the warranty.
 */
function addYears(ymd, years) {
  const t = parseYmd(ymd);
  if (t === null) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear() + years;
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const probe = new Date(Date.UTC(y, mo, day));
  if (probe.getUTCMonth() !== mo) return toYmd(Date.UTC(y, mo + 1, 0)); // last day of target month
  return toYmd(probe);
}

export function daysBetween(fromYmd, toYmdStr) {
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmdStr);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY);
}

/* -------------------------------------------------- conditional registered terms */

/**
 * Resolve what a REGISTERED unit's parts term actually is.
 *
 * For a plain-number rule (`registeredPartsYears` set) this is trivial and
 * certain. For a conditional rule (`registeredPartsYears: null`), the real
 * term depends on a fact `facts` almost never carries — see the comment on
 * `BRAND_RULES`. If it happens to be there and matches, the term is resolved
 * with certainty. Otherwise the guaranteed floor is returned, `resolved` is
 * false, and `pending` lists what was checked and came up empty, for the
 * caller to explain.
 *
 * @param {object} rule
 * @param {object} facts
 * @returns {{years: number, resolved: boolean, pending: object[]}}
 */
function resolveRegisteredTerm(rule, facts) {
  if (rule.registeredPartsYears != null) {
    return { years: rule.registeredPartsYears, resolved: true, pending: [] };
  }
  const options = rule.conditionalRegisteredTerms ?? [];
  for (const opt of options) {
    if (opt.factKey && facts?.[opt.factKey] === opt.factValue) {
      return { years: opt.years, resolved: true, pending: [] };
    }
  }
  return { years: rule.unregisteredPartsYears, resolved: false, pending: options };
}

/** The best case a registered unit could reach under this rule, for messaging. */
function maxRegisteredTerm(rule) {
  if (rule.registeredPartsYears != null) return rule.registeredPartsYears;
  const options = rule.conditionalRegisteredTerms ?? [];
  return options.length ? Math.max(...options.map((o) => o.years)) : rule.unregisteredPartsYears;
}

/** One line per unresolved option, for a note: "10 years if X; or 12 years if Y". */
function describePendingOptions(pending) {
  return pending.map((o) => `${o.years} years if ${o.description}`).join('; or ');
}

/* ---------------------------------------------------------------- derivation */

/**
 * Work out what is known and what needs doing about one unit's warranty.
 *
 * @param {object} facts   canonical field_key -> value, as `extractions` holds them
 * @param {string} [today] YYYY-MM-DD; injected rather than read from the clock so
 *                         this is testable and so a batch run is self-consistent
 * @returns {{
 *   brand: string|null, brandLabel: string|null, brandVerified: boolean,
 *   installDate: string|null, installDatePrecision: 'day'|'month'|null,
 *   registrationOnFile: string|null, registrationPrecision: 'day'|'month'|null,
 *   registrationDeadline: string|null, daysToRegister: number|null,
 *   registrationState: 'on_file'|'due'|'window_closed'|'unknown',
 *   expires: string|null, expiresBasis: 'printed'|'computed'|null,
 *   expiresPrecision: 'day'|'month'|null,
 *   termYears: number|null, termConditional: boolean,
 *   daysToExpiry: number|null, action: string|null, notes: string[]
 * }}
 */
export function deriveWarranty(facts = {}, today = null, pack = null) {
  const notes = [];
  const brand = normalizeBrand(facts.manufacturer, pack);
  const entry = brand ? brandRulesForPack(pack)[brand] : null;
  const rule = entry?.rule ?? null;

  // Accepts YYYY-MM-DD, YYYY-MM, MM/YYYY, MM/DD/YYYY and "Month YYYY" — see
  // normalizeDate. A month-only source (a maintenance agreement that only
  // ever prints "installed 06/2021") is real, usable data, not a rejected one.
  const installParsed = normalizeDate(facts.installation_date);
  const installDate = installParsed?.ymd ?? null;
  const installDatePrecision = installParsed?.precision ?? null;

  const registrationParsed = normalizeDate(facts.warranty_registered_date);
  const registrationOnFile = registrationParsed?.ymd ?? null;
  const registrationPrecision = registrationParsed?.precision ?? null;

  const printedExpiryParsed = normalizeDate(facts.warranty_expires);
  const printedExpiry = printedExpiryParsed?.ymd ?? null;

  const out = {
    brand,
    brandLabel: entry?.label ?? (facts.manufacturer ? String(facts.manufacturer) : null),
    brandVerified: Boolean(rule),
    installDate,
    installDatePrecision,
    registrationOnFile,
    registrationPrecision,
    registrationDeadline: null,
    daysToRegister: null,
    registrationState: registrationOnFile ? 'on_file' : 'unknown',
    expires: null,
    expiresBasis: null,
    expiresPrecision: null,
    termYears: null,
    // True only when termYears is a guaranteed floor standing in for a
    // registered term this rule can't pin down without a fact we don't have —
    // see resolveRegisteredTerm. False for every unconditional brand and for
    // the plain unregistered case, where the number shown is simply correct.
    termConditional: false,
    daysToExpiry: null,
    action: null,
    notes,
  };

  if (!brand) notes.push(`Manufacturer not recognised${facts.manufacturer ? ` ("${facts.manufacturer}")` : ''}.`);
  else if (!rule) notes.push(`${entry.label} warranty terms not verified yet — no deadline computed.`);
  if (rule && entry?.caveats?.length) {
    for (const caveat of entry.caveats) notes.push(`${entry.label}: ${caveat}`);
  }
  if (!installDate) notes.push('No installation date on file.');
  if (installDatePrecision === 'month') notes.push('Installation date is month precision — exact day unknown; the 1st is used for arithmetic only.');
  if (registrationPrecision === 'month') notes.push('Registration date is month precision — exact day unknown; the 1st is used for arithmetic only.');

  // ---- 1. registration window -------------------------------------------
  if (rule && installDate) {
    out.registrationDeadline = addDays(installDate, rule.registrationWindowDays);

    if (registrationOnFile) {
      const late = daysBetween(out.registrationDeadline, registrationOnFile);
      if (late !== null && late > 0) {
        notes.push(`Registered ${late} day(s) after the ${rule.registrationWindowDays}-day window closed.`);
      }
    }
  }

  // ---- 2. term and expiry ------------------------------------------------
  // A printed date always wins. We never overwrite what a document says.
  if (printedExpiry) {
    out.expires = printedExpiry;
    out.expiresBasis = 'printed';
    out.expiresPrecision = printedExpiryParsed.precision;
    if (printedExpiryParsed.precision === 'month') notes.push('Printed expiry is month precision — exact day unknown; the 1st is used for arithmetic only.');
  } else if (rule && installDate) {
    // Registered within the window earns the long term. Absence of a
    // registration date is NOT evidence of non-registration — it means we
    // have no document saying so — so the conservative (shorter) term is used
    // and the note says why.
    let registeredInTime = false;
    if (registrationOnFile) {
      const late = daysBetween(out.registrationDeadline, registrationOnFile);
      registeredInTime = late !== null && late <= 0;
    }

    if (registeredInTime) {
      const resolved = resolveRegisteredTerm(rule, facts);
      out.termYears = resolved.years;
      out.termConditional = !resolved.resolved;
      if (!resolved.resolved && resolved.pending.length) {
        notes.push(
          `${entry.label}: registered, but the extended term depends on something not on ` +
          `file (${describePendingOptions(resolved.pending)}). Using the guaranteed ` +
          `${rule.unregisteredPartsYears}-year floor until that's confirmed.`
        );
      }
    } else {
      out.termYears = rule.unregisteredPartsYears;
    }
    out.expires = addYears(installDate, out.termYears);
    out.expiresBasis = 'computed';
    // A computed expiry can only be as precise as the install date it's
    // anchored to — addYears preserves day-of-month, so month precision
    // carries straight through.
    out.expiresPrecision = installDatePrecision;

    if (!registrationOnFile) {
      if (rule.registeredPartsYears != null) {
        notes.push(
          `No registration on file, so the ${rule.unregisteredPartsYears}-year term is assumed. ` +
          `If it was registered within ${rule.registrationWindowDays} days, the term is ` +
          `${rule.registeredPartsYears} years — confirm and record it.`
        );
      } else {
        const options = describePendingOptions(rule.conditionalRegisteredTerms ?? []);
        notes.push(
          `No registration on file, so the ${rule.unregisteredPartsYears}-year term is assumed. ` +
          `If it was registered within ${rule.registrationWindowDays} days, the term could be ` +
          `higher depending on conditions not on file${options ? ` (${options})` : ''} — confirm and record it.`
        );
      }
    }
  }

  // ---- 3. urgency, only if a clock was supplied --------------------------
  if (today) Object.assign(out, describeWarranty(out, today));

  return out;
}

/**
 * Turn the stable, stored part of a derivation into what to say today.
 *
 * Split out from deriveWarranty so that ingest time and read time cannot drift:
 * ingestion stores dates, the reminder list re-runs THIS against the same dates
 * whenever someone looks. Nothing time-sensitive is ever persisted, because
 * "19 days left to register" is true for exactly one day and would be a lie by
 * tomorrow morning.
 *
 * `expiringWithinDays` is the caller's horizon, not a constant. It used to be
 * hardcoded at 365 while the endpoint advertised windows up to ten years, so a
 * request for everything expiring in the next three years fetched those rows
 * from Postgres and then silently dropped them for having no action. The
 * horizon has to be the same number in both places or the parameter is a lie.
 *
 * @param {object} stable  a stored warranty object from deriveWarranty
 * @param {string} today   YYYY-MM-DD
 * @param {{expiringWithinDays?: number}} [opts]
 */
export function describeWarranty(stable, today, { expiringWithinDays = 365 } = {}) {
  const rule = stable?.brand ? BRAND_RULES[stable.brand]?.rule ?? null : null;
  const label = stable?.brandLabel ?? 'the manufacturer';

  const out = {
    daysToRegister: null,
    daysToExpiry: null,
    registrationState: stable?.registrationOnFile ? 'on_file' : 'unknown',
    urgency: null,
    action: null,
  };
  if (!today) return out;

  if (!stable?.registrationOnFile && stable?.registrationDeadline) {
    out.daysToRegister = daysBetween(today, stable.registrationDeadline);
    if (out.daysToRegister !== null) {
      out.registrationState = out.daysToRegister >= 0 ? 'due' : 'window_closed';
    }
  }
  if (stable?.expires) out.daysToExpiry = daysBetween(today, stable.expires);

  const computed = stable?.expiresBasis === 'computed' ? ' (computed)' : '';

  // Once registered, a conditional-term brand's ceiling is still unmet if the
  // deciding fact never arrived — flagged here so the expiring/expired
  // messages don't quietly understate coverage that might actually be longer.
  const unmetCeiling =
    rule && rule.registeredPartsYears == null && stable?.registrationOnFile
      ? maxRegisteredTerm(rule)
      : null;
  const ceilingCaveat =
    unmetCeiling !== null && unmetCeiling > (stable.termYears ?? 0)
      ? ` Coverage may run longer if ${label}'s registration condition is confirmed — check before treating this as final.`
      : '';

  // The expiry itself may only be known to the month (see normalizeDate /
  // deriveWarranty) — an "expired 3 days ago" reading day precision, then
  // computed off a placeholder day-of-month, would overstate how exactly this
  // is known.
  const precisionCaveat = stable?.expiresPrecision === 'month' ? ' Month precision — exact day unknown.' : '';

  if (out.registrationState === 'due' && rule) {
    out.urgency = out.daysToRegister <= 14 ? 'register_urgent' : 'register_soon';
    out.action =
      rule.registeredPartsYears != null
        ? `Register with ${label} within ${out.daysToRegister} day(s) ` +
          `(by ${stable.registrationDeadline}) to secure the ${rule.registeredPartsYears}-year parts term ` +
          `instead of ${rule.unregisteredPartsYears}.`
        : `Register with ${label} within ${out.daysToRegister} day(s) ` +
          `(by ${stable.registrationDeadline}) — depending on conditions not on file, the parts term ` +
          `could reach ${maxRegisteredTerm(rule)} years instead of the guaranteed ${rule.unregisteredPartsYears}.`;
  } else if (out.registrationState === 'window_closed' && rule) {
    out.urgency = 'register_missed';
    out.action =
      rule.registeredPartsYears != null
        ? `Registration window closed ${Math.abs(out.daysToRegister)} day(s) ago. ` +
          `Confirm whether this unit was registered — if not, the parts term is ` +
          `${rule.unregisteredPartsYears} years, not ${rule.registeredPartsYears}.`
        : `Registration window closed ${Math.abs(out.daysToRegister)} day(s) ago. ` +
          `Confirm whether this unit was registered — if not, the parts term is ` +
          `${rule.unregisteredPartsYears} years, not up to ${maxRegisteredTerm(rule)}.`;
  } else if (out.daysToExpiry !== null && out.daysToExpiry < 0) {
    out.urgency = 'expired';
    out.action = `Parts warranty expired ${Math.abs(out.daysToExpiry)} day(s) ago${computed}.${precisionCaveat}${ceilingCaveat}`;
  } else if (out.daysToExpiry !== null && out.daysToExpiry <= expiringWithinDays) {
    out.urgency = 'expiring';
    out.action = `Parts warranty ends in ${out.daysToExpiry} day(s)${computed} — extended-warranty opportunity.${precisionCaveat}${ceilingCaveat}`;
  }

  return out;
}

/* ------------------------------------------------------------------ alerts */

/**
 * Bucket a stored derivation into one alert tier for the reminder/alerts UI.
 *
 * Pure: no clock read except `today`. Priority order matters — a registration
 * deadline closing in the next 30 days is the most operationally urgent case
 * (missing it silently costs years of coverage) and is reported even if the
 * unregistered-floor expiry it would otherwise bucket into is further out.
 *
 * @param {ReturnType<typeof deriveWarranty>} stable
 * @param {string|null} today YYYY-MM-DD
 * @returns {'expired'|'expiring-30'|'expiring-90'|'expiring-365'|'unregistered-window-closing'|'ok'|'unknown'}
 */
export function alertTier(stable, today) {
  if (!today || !isPlausibleToday(today)) return 'unknown';

  if (!stable?.registrationOnFile && stable?.registrationDeadline) {
    const daysToRegister = daysBetween(today, stable.registrationDeadline);
    if (daysToRegister !== null && daysToRegister >= 0 && daysToRegister <= 30) {
      return 'unregistered-window-closing';
    }
  }

  const daysToExpiry = stable?.expires ? daysBetween(today, stable.expires) : null;
  if (daysToExpiry === null) return 'unknown';
  if (daysToExpiry < 0) return 'expired';
  if (daysToExpiry <= 30) return 'expiring-30';
  if (daysToExpiry <= 90) return 'expiring-90';
  if (daysToExpiry <= 365) return 'expiring-365';
  return 'ok';
}

/**
 * Whether this unit is worth an extended-warranty / maintenance-agreement
 * pitch, and why. Conservative: eligibility always names the fact that earned
 * it, never a guess. Three independent reasons can apply (a unit can be both
 * expired AND parts-only) — all that apply are listed.
 *
 *   1. Expired parts warranty.
 *   2. Expiring within 365 days (the window is still open — sell now).
 *   3. A verified brand rule, which in this file always means parts-only
 *      coverage (no labor term is ever modeled here) — a standing labor/
 *      maintenance-agreement gap regardless of how close to expiry.
 *
 * @param {ReturnType<typeof deriveWarranty>} stable
 * @param {string|null} today
 * @returns {{eligible: boolean, reason: string}}
 */
export function upsell(stable, today) {
  const reasons = [];
  const tier = alertTier(stable, today);

  if (tier === 'expired') {
    reasons.push('Parts warranty has expired — pitch an extended warranty or maintenance agreement.');
  } else if (tier === 'expiring-30' || tier === 'expiring-90' || tier === 'expiring-365') {
    reasons.push('Parts warranty expires within the next year — the extended-warranty window is still open.');
  }

  if (stable?.brand && BRAND_RULES[stable.brand]?.rule) {
    reasons.push(
      `${stable.brandLabel ?? 'The manufacturer'}'s warranty covers parts only — no labor term is modeled, ` +
      'so a maintenance agreement fills a real gap regardless of expiry.'
    );
  }

  return { eligible: reasons.length > 0, reason: reasons.join(' ') || 'No upsell signal on file.' };
}

/**
 * How many brands we can actually act on. Worth surfacing: a tenant whose fleet
 * is mostly Carrier gets very little from this feature until Carrier is
 * verified, and that should be visible rather than showing up as silence.
 *
 * "Verified" here means "has a rule object", not "resolves every case with
 * certainty" — a brand with a conditional registered term (Carrier, Bryant,
 * Rheem, Ruud, Daikin) is verified and does compute a registration deadline
 * and a guaranteed floor; it just can't always confirm the higher number.
 * `conditional` lists those out explicitly, and `confidence` on each verified
 * entry flags the ones whose citation is one step removed from the brand
 * (currently just Ruud), so "usable" doesn't quietly mean "every figure is
 * equally solid".
 */
export function ruleCoverage() {
  const all = Object.entries(BRAND_RULES);
  const verified = all.filter(([, v]) => v.rule);
  const conditional = verified.filter(([, v]) => v.rule.conditionalRegisteredTerms?.length);
  return {
    verified: verified.map(([k, v]) => ({
      brand: k,
      label: v.label,
      source: v.source,
      verified: v.verified,
      confidence: v.confidence ?? 'high',
    })),
    unverified: all.filter(([, v]) => !v.rule).map(([k, v]) => ({ brand: k, label: v.label })),
    conditional: conditional.map(([k, v]) => ({
      brand: k,
      label: v.label,
      pendingFacts: [...new Set(v.rule.conditionalRegisteredTerms.map((c) => c.factKey))],
    })),
    verifiedCount: verified.length,
    totalCount: all.length,
  };
}
