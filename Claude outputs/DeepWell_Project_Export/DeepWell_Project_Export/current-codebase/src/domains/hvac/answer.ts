/**
 * HVAC question understanding. Deterministic, works against the entity graph
 * snapshot, and every fact it emits carries a source. This is what the Claude
 * provider replaces — the UI never knows which one answered.
 */
import { assemble, dateOf, fmtDate, fmtMoney, noAnswer, normalize, numOf, str } from '../../core/answer';
import { entitiesOfType, isAnswerable, sourcesFor, type GraphSnapshot } from '../../core/entityGraph';
import type { Answer, AskOptions, Entity, Fact, FactStatus, SourceRef } from '../../core/types';
import { warrantyStatus } from '../../components/WarrantyStatusBadge';

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

interface Resolved {
  property?: Entity;
  equipment?: Entity;
  technician?: Entity;
  customer?: Entity;
  manufacturer?: string;
  equipmentType?: string;
}

const MANUFACTURERS = ['carrier', 'lennox', 'rheem', 'trane', 'york'];
const TYPES: Record<string, string> = {
  furnace: 'Furnace',
  'heat pump': 'Heat Pump',
  heatpump: 'Heat Pump',
  ac: 'AC',
  'a c': 'AC',
  'air conditioner': 'AC',
  condenser: 'AC',
  commercial: 'Commercial Unit',
  rooftop: 'Commercial Unit',
};

const STREET_NOISE = new Set(['e', 'w', 'n', 's', 'rd', 'st', 'ave', 'blvd', 'dr', 'ln', 'ct', 'road', 'street', 'avenue', 'drive', 'lane']);

function streetTokens(address: string): { number: string | null; words: string[] } {
  const parts = normalize(address).split(' ');
  const number = parts[0] && /^\d+$/.test(parts[0]) ? parts[0] : null;
  const words = parts.filter((p) => !/^\d+$/.test(p) && !STREET_NOISE.has(p) && p.length > 2);
  return { number, words };
}

function resolveProperty(q: string, g: GraphSnapshot): Entity | undefined {
  const qTokens = q.split(' ');
  let best: { e: Entity; score: number } | null = null;
  for (const p of entitiesOfType(g, 'property')) {
    const { number, words } = streetTokens(str(p, 'address'));
    let score = 0;
    if (number && qTokens.includes(number)) score += 3;
    for (const w of words) if (q.includes(w)) score += 2;
    // "24th" style ordinals
    if (words.length === 0) {
      const ord = normalize(str(p, 'address')).split(' ').find((t) => /^\d+(st|nd|rd|th)$/.test(t));
      if (ord && q.includes(ord)) score += 2;
    }
    if (score >= 2 && (!best || score > best.score)) best = { e: p, score };
  }
  // Disambiguate shared street names (two Camelback properties) by number; else the higher score wins
  return best?.e;
}

function resolveEquipmentBySerial(q: string, g: GraphSnapshot): Entity | undefined {
  const compact = q.replace(/\s+/g, '');
  for (const e of entitiesOfType(g, 'equipment')) {
    const serial = normalize(str(e, 'serial'));
    if (!serial) continue;
    if (q.includes(serial) || compact.includes(serial.replace(/-/g, ''))) return e;
    // last 6 digits alone ("serial 234567") — only if unique
    const digits = serial.split('-').pop() ?? '';
    if (digits.length >= 6 && new RegExp(`(^|\\D)${digits}(\\D|$)`).test(q)) {
      const matches = entitiesOfType(g, 'equipment').filter((x) => normalize(str(x, 'serial')).endsWith(digits));
      if (matches.length === 1) return e;
    }
  }
  return undefined;
}

function resolveEquipmentByModel(q: string, g: GraphSnapshot): Entity | undefined {
  for (const e of entitiesOfType(g, 'equipment')) {
    const model = normalize(str(e, 'model'));
    if (model.length >= 4 && q.includes(model)) return e;
  }
  return undefined;
}

function resolvePersonBy(q: string, g: GraphSnapshot, type: 'technician' | 'customer'): Entity | undefined {
  const qTokens = new Set(q.split(' '));
  let best: { e: Entity; score: number } | null = null;
  for (const t of entitiesOfType(g, type)) {
    const name = normalize(str(t, 'name'));
    if (q.includes(name)) return t;
    const generic = new Set(['family', 'inc', 'management', 'residence', 'llc']);
    const parts = name.split(' ').filter((p) => p.length > 2);
    const hits = parts.filter((p) => qTokens.has(p));
    // Technicians: first or last name is enough ("Carlos", "Chen").
    // Customers: the surname ("Torres place") or two words ("Office Plaza") — a first name alone is not a match.
    const surname = [...parts].reverse().find((p) => !generic.has(p));
    const ok = type === 'technician' ? hits.length > 0 : hits.length >= 2 || (!!surname && qTokens.has(surname));
    if (ok && (!best || hits.length > best.score)) best = { e: t, score: hits.length };
  }
  return best?.e;
}

/** Everything the question names, plus the question with those names removed (for intent detection). */
function resolve(q: string, g: GraphSnapshot): Resolved & { rest: string } {
  const r: Resolved = {};
  let rest = q;
  const strip = (text: string) => {
    const n = normalize(text);
    if (n && rest.includes(n)) rest = rest.replace(n, ' ');
  };
  const eq = resolveEquipmentBySerial(q, g) ?? resolveEquipmentByModel(q, g);
  if (eq) {
    r.equipment = eq;
    strip(str(eq, 'serial'));
    strip(str(eq, 'model'));
  }
  const prop = resolveProperty(q, g);
  if (prop) {
    r.property = prop;
    for (const w of normalize(str(prop, 'address')).split(' ')) if (w.length > 2) rest = rest.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
  }
  const cust = resolvePersonBy(q, g, 'customer');
  if (cust) {
    r.customer = cust;
    strip(str(cust, 'name'));
    const surname = normalize(str(cust, 'name')).split(' ').pop();
    if (surname) rest = rest.replace(new RegExp(`\\b${surname}\\b`, 'g'), ' ');
  }
  const tech = resolvePersonBy(rest, g, 'technician');
  if (tech) {
    r.technician = tech;
    strip(str(tech, 'name'));
    for (const w of normalize(str(tech, 'name')).split(' ')) rest = rest.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  const m = MANUFACTURERS.find((m) => new RegExp(`\\b${m}\\b`).test(rest));
  if (m) r.manufacturer = m.charAt(0).toUpperCase() + m.slice(1);
  for (const [k, v] of Object.entries(TYPES)) {
    if (new RegExp(`(^|\\s)${k}(s|es)?(\\s|$)`).test(rest)) {
      r.equipmentType = v;
      break;
    }
  }
  // A customer resolves to their property when they only have one
  if (!r.property && r.customer) {
    const props = entitiesOfType(g, 'property').filter((p) => str(p, 'customerId') === r.customer?.id);
    if (props.length === 1 && props[0]) r.property = props[0];
  }
  // Equipment implies its property
  if (!r.property && r.equipment) {
    const p = g.entities[str(r.equipment, 'propertyId')];
    if (p) r.property = p;
  }
  return { ...r, rest };
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

interface Window {
  from: Date;
  to: Date;
  label: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function parseWindow(q: string, now: Date): Window | null {
  const y = now.getFullYear();
  const season = q.match(/\b(last|this)\s+(spring|summer|fall|autumn|winter)\b/);
  if (season) {
    const which = season[1];
    const s = season[2] === 'autumn' ? 'fall' : season[2];
    const ranges: Record<string, [number, number, number, number]> = {
      spring: [2, 20, 5, 20],
      summer: [5, 21, 8, 21],
      fall: [8, 22, 11, 20],
      winter: [11, 21, 2, 19],
    };
    const r = ranges[s ?? 'fall'] ?? [8, 22, 11, 20];
    // "this fall" = this calendar year's; "last fall" = the most recent one that has finished
    let year = y;
    if (which === 'last') {
      const endThisYear = s === 'winter' ? new Date(y + 1, r[2], r[3]) : new Date(y, r[2], r[3]);
      if (endThisYear > now) year -= 1;
    }
    const from = new Date(year, r[0], r[1]);
    const to = s === 'winter' ? new Date(year + 1, r[2], r[3]) : new Date(year, r[2], r[3]);
    return { from, to, label: `${which} ${s}` };
  }
  if (/\bthis year\b/.test(q)) return { from: new Date(y, 0, 1), to: new Date(y, 11, 31), label: 'this year' };
  if (/\blast year\b/.test(q)) return { from: new Date(y - 1, 0, 1), to: new Date(y - 1, 11, 31), label: 'last year' };
  if (/\bnext year\b/.test(q)) return { from: new Date(y + 1, 0, 1), to: new Date(y + 1, 11, 31), label: 'next year' };
  const lastN = q.match(/\b(last|past)\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (lastN) {
    const n = Number(lastN[2]);
    const unit = lastN[3];
    const from = new Date(now);
    if (unit === 'day') from.setDate(from.getDate() - n);
    if (unit === 'week') from.setDate(from.getDate() - 7 * n);
    if (unit === 'month') from.setMonth(from.getMonth() - n);
    if (unit === 'year') from.setFullYear(from.getFullYear() - n);
    return { from, to: now, label: `in the last ${n} ${unit}${n === 1 ? '' : 's'}` };
  }
  const monthIdx = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(q));
  if (monthIdx >= 0) {
    const yr = q.match(/\b(20\d{2})\b/);
    const year = yr ? Number(yr[1]) : monthIdx <= now.getMonth() ? y : y - 1;
    const from = new Date(year, monthIdx, 1);
    const to = new Date(year, monthIdx + 1, 0);
    return { from, to, label: `in ${(MONTHS[monthIdx] ?? '').replace(/^./, (c) => c.toUpperCase())} ${year}` };
  }
  const yr = q.match(/\b(in|during|for)\s+(20\d{2})\b/) ?? q.match(/\b(20\d{2})\b/);
  if (yr) {
    const year = Number(yr[2] ?? yr[1]);
    return { from: new Date(year, 0, 1), to: new Date(year, 11, 31), label: `in ${year}` };
  }
  if (/\bsince (the )?install/.test(q)) return null;
  return null;
}

function parseHorizon(q: string, now: Date): { to: Date; label: string } | null {
  const m = q.match(/\b(next|within|in)\s+(\d+)\s+(day|week|month|year)s?\b/) ?? q.match(/\b(\d+)\s+(day|week|month|year)s?\b/);
  const to = new Date(now);
  if (!m) {
    if (/\bnext quarter|this quarter\b/.test(q)) { to.setDate(to.getDate() + 90); return { to, label: 'the next 90 days' }; }
    if (/\bwithin a year|next 12 months\b/.test(q)) { to.setFullYear(to.getFullYear() + 1); return { to, label: 'the next 12 months' }; }
    if (/\bnext month\b/.test(q)) { to.setMonth(to.getMonth() + 1); return { to, label: 'the next month' }; }
    if (/\bsoon\b/.test(q)) { to.setDate(to.getDate() + 90); return { to, label: 'the next 90 days' }; }
    return null;
  }
  const n = Number(m[2] ?? m[1]);
  const unit = m[3] ?? m[2];
  if (unit === 'day') to.setDate(to.getDate() + n);
  if (unit === 'week') to.setDate(to.getDate() + 7 * n);
  if (unit === 'month') to.setMonth(to.getMonth() + n);
  if (unit === 'year') to.setFullYear(to.getFullYear() + n);
  return { to, label: `the next ${n} ${unit}${n === 1 ? '' : 's'}` };
}

// ---------------------------------------------------------------------------
// Fact builders
// ---------------------------------------------------------------------------

type Ctx = { g: GraphSnapshot; inc: boolean; now: Date; unverified: Set<string> };

/** Build a fact for an entity field, or null if no answerable source backs it. Tracks unverified sources. */
function fact(ctx: Ctx, e: Entity, field: string, label: string, opts: { value?: string; status?: FactStatus; kind?: Fact['kind'] } = {}): Fact | null {
  const value = opts.value ?? str(e, field);
  if (!value) return null;
  const sources = sourcesFor(ctx.g, e.id, field, ctx.inc);
  if (!sources.length) {
    for (const s of sourcesFor(ctx.g, e.id, field, true)) ctx.unverified.add(s.documentId);
    return null;
  }
  const f: Fact = { label, value, sources, entityId: e.id };
  if (opts.status) f.status = opts.status;
  if (opts.kind) f.kind = opts.kind;
  return f;
}

const push = (arr: Fact[], f: Fact | null) => {
  if (f) arr.push(f);
};

function warrantyFact(ctx: Ctx, eq: Entity): Fact | null {
  const info = warrantyStatus(dateOf(eq, 'warrantyExpiry'), ctx.now);
  const statusMap: Record<typeof info.status, FactStatus> = { active: 'ok', expiring: 'warn', expired: 'bad', unknown: 'muted' };
  const expiry = dateOf(eq, 'warrantyExpiry');
  const value = expiry ? `${info.label} · ${fmtDate(expiry)}` : 'No warranty on file';
  return fact(ctx, eq, 'warrantyExpiry', 'Warranty', { value, status: statusMap[info.status], kind: 'date' });
}

function equipmentFacts(ctx: Ctx, eq: Entity, includeLocation = true): Fact[] {
  const out: Fact[] = [];
  push(out, fact(ctx, eq, 'serial', 'Serial', { kind: 'serial' }));
  push(out, fact(ctx, eq, 'model', 'Model'));
  push(out, fact(ctx, eq, 'manufacturer', 'Manufacturer'));
  push(out, fact(ctx, eq, 'equipmentType', 'Type'));
  push(out, fact(ctx, eq, 'installDate', 'Installed', { kind: 'date' }));
  push(out, fact(ctx, eq, 'installedByName', 'Installed by'));
  push(out, warrantyFact(ctx, eq));
  if (includeLocation) {
    const p = ctx.g.entities[str(eq, 'propertyId')];
    if (p) push(out, fact(ctx, p, 'address', 'Location'));
  }
  return out;
}

function serviceFacts(ctx: Ctx, s: Entity, label?: string): Fact[] {
  const out: Fact[] = [];
  const when = dateOf(s, 'date');
  const head = label ?? (when ? fmtDate(when) : 'Visit');
  const work = fact(ctx, s, 'workPerformed', head);
  if (!work) return out; // no answerable source → this visit is invisible
  out.push(work);
  push(out, fact(ctx, s, 'technicianName', 'Technician'));
  const cost = numOf(s, 'cost');
  push(out, fact(ctx, s, 'cost', 'Cost', { value: fmtMoney(cost), kind: 'money' }));
  return out;
}

function visitsFor(ctx: Ctx, filter: { propertyId?: string; equipmentId?: string; technicianId?: string; window?: Window | null }): Entity[] {
  return entitiesOfType(ctx.g, 'service')
    .filter((s) => !filter.propertyId || str(s, 'propertyId') === filter.propertyId)
    .filter((s) => !filter.equipmentId || str(s, 'equipmentId') === filter.equipmentId)
    .filter((s) => !filter.technicianId || str(s, 'technicianId') === filter.technicianId)
    .filter((s) => {
      if (!filter.window) return true;
      const d = dateOf(s, 'date');
      return !!d && d >= filter.window.from && d <= filter.window.to;
    })
    .sort((a, b) => (dateOf(b, 'date')?.getTime() ?? 0) - (dateOf(a, 'date')?.getTime() ?? 0));
}

/** Visits whose work-order is answerable at the current setting. */
function answerableVisits(ctx: Ctx, visits: Entity[]): Entity[] {
  return visits.filter((s) => sourcesFor(ctx.g, s.id, 'workPerformed', ctx.inc).length > 0);
}
function noteUnverifiedVisits(ctx: Ctx, visits: Entity[]) {
  for (const s of visits) {
    if (sourcesFor(ctx.g, s.id, 'workPerformed', ctx.inc).length === 0) {
      for (const src of sourcesFor(ctx.g, s.id, 'workPerformed', true)) ctx.unverified.add(src.documentId);
    }
  }
}

function equipmentAt(ctx: Ctx, propertyId: string): Entity[] {
  return entitiesOfType(ctx.g, 'equipment').filter((e) => str(e, 'propertyId') === propertyId);
}

function label(e: Entity): string {
  return `${str(e, 'manufacturer')} ${str(e, 'equipmentType')} (${str(e, 'model')})`.trim();
}

function closestDocs(ctx: Ctx, q: string, n = 3): SourceRef[] {
  const tokens = q.split(' ').filter((t) => t.length > 2);
  const scored = Object.values(ctx.g.docs)
    .filter((d) => isAnswerable(d, true))
    .map((d) => {
      const text = normalize(`${d.filename} ${d.preview}`);
      const score = tokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  return scored.map(({ d }) => ({ documentId: d.id, location: { page: 1 }, excerpt: d.preview.split('\n')[0] ?? d.filename }));
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

const RX = {
  warranty: /\b(warrant\w*|covered|coverage)\b/,
  expiring: /\b(expir\w*|run(s|ning)? out|laps\w*)\b/,
  lastVisit: /\b(last (visit|service|serviced|time|there|out)|most recent|when did we last|when were we last|when was .* last)/,
  cost: /\b(cost|charge|charged|paid|how much|bill|invoice total|total|spend|spent|pay|price)\b/,
  install: /\b(install|installed|put in|when was .* (put in|installed)|install date)\b/,
  who: /\b(who (installed|put in))\b/,
  whoServiced: /\b(who (serviced|worked|was (out|there)|did|has been|went))\b/,
  whatIs: /\b(what (is|kind|type|model|unit)|what(s| is) (this|that|it))\b/,
  history: /\b(history|story|everything|all (the )?(records|work|visits)|tell me about|what do we (have|know))\b/,
  list: /\b(which|what|list|show|all|how many|any)\b/,
  phone: /\b(phone|number|call|reach|contact)\b/,
  certs: /\b(cert|certified|certification|epa|license)\b/,
  work: /\b(do|did|done|work|worked|service|serviced|visit|visited|perform)/,
  next: /\b(next|upcoming|due|soon)\b/,
};

export function answerHvac(question: string, g: GraphSnapshot, opts: AskOptions = {}): Answer {
  const q = normalize(question);
  const now = opts.now ?? new Date();
  const inc = opts.includeUnverified ?? false;
  const ctx: Ctx = { g, inc, now, unverified: new Set() };
  const r = resolve(q, g);
  // Intent detection runs on the question with names/addresses removed ("Price Rd" must not read as a price)
  const qi = r.rest;
  const window = parseWindow(qi, now);
  const finish = (text: string, facts: Fact[], conf: number, entityId?: string, interpretation?: string): Answer => {
    const a = assemble(text, facts, {
      confidence: conf,
      unverifiedDocIds: Array.from(ctx.unverified),
      closest: facts.length ? [] : closestDocs(ctx, q),
      ...(entityId ? { entityId } : {}),
      ...(interpretation ? { interpretation } : {}),
    });
    if (a.kind === 'no-answer' && ctx.unverified.size && !/unverified/i.test(a.text)) {
      a.text = `${a.text} ${ctx.unverified.size} unverified ${ctx.unverified.size === 1 ? 'document matches' : 'documents match'} — turn on “include unverified” to see ${ctx.unverified.size === 1 ? 'it' : 'them'}.`;
    }
    return a;
  };

  // ---- Expiring lists: "which units expire in the next 90 days", "warranties expiring this year", "Carrier units expiring"
  if ((RX.expiring.test(qi) || (RX.warranty.test(qi) && (RX.list.test(qi) || RX.next.test(qi)))) && !r.equipment && !r.property) {
    const h = parseHorizon(qi, now);
    const horizon = window ? window.to : h ? h.to : null;
    const from = window ? window.from : now;
    const wantExpired = /\b(expired|lapsed|out of warranty|no longer)\b/.test(qi);
    let units = entitiesOfType(g, 'equipment');
    if (r.manufacturer) units = units.filter((e) => str(e, 'manufacturer') === r.manufacturer);
    if (r.equipmentType) units = units.filter((e) => str(e, 'equipmentType') === r.equipmentType);
    if (r.technician) units = units.filter((e) => str(e, 'installedBy') === r.technician?.id);
    const withExpiry = units
      .map((e) => ({ e, d: dateOf(e, 'warrantyExpiry') }))
      .filter((x): x is { e: Entity; d: Date } => x.d instanceof Date)
      .sort((a, b) => a.d.getTime() - b.d.getTime());
    const scope = [r.manufacturer, r.equipmentType ? r.equipmentType.toLowerCase() : 'unit'].filter(Boolean).join(' ');
    if (wantExpired) {
      const expired = withExpiry.filter((x) => x.d < now && (!window || (x.d >= window.from && x.d <= window.to)));
      const whenLabel = window ? ` ${window.label}` : '';
      const facts: Fact[] = [];
      for (const { e } of expired) {
        const p = g.entities[str(e, 'propertyId')];
        push(facts, fact(ctx, e, 'warrantyExpiry', `${label(e)} — ${str(p, 'address')}`, { value: `Expired ${fmtDate(dateOf(e, 'warrantyExpiry'))}`, status: 'bad', kind: 'date' }));
      }
      const text = expired.length
        ? window
          ? `${expired.length} ${scope}${expired.length === 1 ? '' : 's'} went out of warranty${whenLabel}.`
          : `${expired.length} ${scope}${expired.length === 1 ? '' : 's'} ${expired.length === 1 ? 'is' : 'are'} out of warranty.`
        : `No ${scope}s went out of warranty${whenLabel}.`;
      return finish(text, facts, 0.92, undefined, `Expired warranties${whenLabel}`);
    }
    if (!horizon) {
      // "which warranties are expiring" with no window → next 12 months
      const to = new Date(now.getTime() + 365 * 86400000);
      const soon = withExpiry.filter((x) => x.d >= now && x.d <= to);
      const facts: Fact[] = [];
      for (const { e, d } of soon) {
        const p = g.entities[str(e, 'propertyId')];
        push(facts, fact(ctx, e, 'warrantyExpiry', `${label(e)} — ${str(p, 'address')}`, { value: fmtDate(d), status: 'warn', kind: 'date' }));
      }
      return finish(
        soon.length ? `${soon.length} ${scope}${soon.length === 1 ? '' : 's'} expire${soon.length === 1 ? 's' : ''} in the next 12 months.` : `No ${scope} warranties expire in the next 12 months.`,
        facts,
        0.9,
        undefined,
        'Warranties expiring in the next 12 months',
      );
    }
    const inWindow = withExpiry.filter((x) => x.d >= from && x.d <= horizon);
    const facts: Fact[] = [];
    for (const { e, d } of inWindow) {
      const p = g.entities[str(e, 'propertyId')];
      push(facts, fact(ctx, e, 'warrantyExpiry', `${label(e)} — ${str(p, 'address')}`, { value: fmtDate(d), status: 'warn', kind: 'date' }));
    }
    const windowLabel = window ? window.label : (h?.label ?? 'the selected period');
    if (inWindow.length) {
      return finish(`${inWindow.length} ${scope}${inWindow.length === 1 ? '' : 's'} expire${inWindow.length === 1 ? 's' : ''} in ${windowLabel}.`, facts, 0.92, undefined, `Warranties expiring in ${windowLabel}`);
    }
    // Honest empty: nothing in the window — show the next ones to expire instead
    const upcoming = withExpiry.filter((x) => x.d >= now).slice(0, 3);
    for (const { e, d } of upcoming) {
      const p = g.entities[str(e, 'propertyId')];
      push(facts, fact(ctx, e, 'warrantyExpiry', `${label(e)} — ${str(p, 'address')}`, { value: fmtDate(d), status: 'ok', kind: 'date' }));
    }
    const nextOne = upcoming[0];
    const text = nextOne
      ? `No ${scope} warranties expire in ${windowLabel}. The next to expire is the ${label(nextOne.e)} at ${str(g.entities[str(nextOne.e, 'propertyId')], 'address')} on ${fmtDate(nextOne.d)}.`
      : `No ${scope} warranties expire in ${windowLabel}, and none are scheduled to expire after that either.`;
    return finish(text, facts, 0.9, undefined, `Warranties expiring in ${windowLabel}`);
  }

  // ---- Technician-centric: "what did Carlos do at Camelback last fall", "who installed the furnace at 24th st", tech phone/certs
  if (r.technician && (RX.phone.test(qi) || RX.certs.test(qi)) && !r.property && !r.equipment) {
    const facts: Fact[] = [];
    if (RX.phone.test(qi)) push(facts, fact(ctx, r.technician, 'phone', 'Phone'));
    if (RX.certs.test(qi)) push(facts, fact(ctx, r.technician, 'certifications', 'Certifications'));
    push(facts, fact(ctx, r.technician, 'specialty', 'Specialty'));
    // Technician profile fields aren't document-backed in the mock; fall back to their work record
    if (!facts.length) {
      const visits = answerableVisits(ctx, visitsFor(ctx, { technicianId: r.technician.id }));
      for (const v of visits.slice(0, 5)) facts.push(...serviceFacts(ctx, v));
      return finish(`${str(r.technician, 'name')}'s contact details aren't on any document in your records. Here is their recent work instead.`, facts, 0.5, r.technician.id);
    }
    return finish(`Here is what your records have for ${str(r.technician, 'name')}.`, facts, 0.85, r.technician.id);
  }

  if (r.technician && (r.property || r.customer) && !RX.install.test(qi)) {
    const propertyId = r.property?.id;
    const all = visitsFor(ctx, { ...(propertyId ? { propertyId } : {}), technicianId: r.technician.id, window });
    noteUnverifiedVisits(ctx, all);
    const visits = answerableVisits(ctx, all);
    const facts: Fact[] = [];
    let total = 0;
    for (const v of visits) {
      facts.push(...serviceFacts(ctx, v));
      total += numOf(v, 'cost') ?? 0;
    }
    const where = r.property ? str(r.property, 'address') : str(r.customer, 'name');
    const when = window ? ` ${window.label}` : '';
    const name = str(r.technician, 'name');
    if (!visits.length) {
      // Say who did go, if anyone did
      const others = answerableVisits(ctx, visitsFor(ctx, { ...(propertyId ? { propertyId } : {}), window }));
      const otherFacts: Fact[] = [];
      for (const v of others.slice(0, 3)) otherFacts.push(...serviceFacts(ctx, v));
      const firstOther = others[0];
      const text = firstOther
        ? `${name} has no recorded visits at ${where}${when}. ${str(firstOther, 'technicianName')} was there on ${fmtDate(dateOf(firstOther, 'date'))}.`
        : `${name} has no recorded visits at ${where}${when}.`;
      return finish(text, otherFacts, 0.8, r.technician.id, `${name} at ${where}${when}`);
    }
    const text =
      visits.length === 1
        ? `${name} made one visit to ${where}${when}: ${str(visits[0], 'workPerformed').toLowerCase()} on ${fmtDate(dateOf(visits[0], 'date'))}, billed ${fmtMoney(numOf(visits[0], 'cost'))}.`
        : `${name} made ${visits.length} visits to ${where}${when}, billed ${fmtMoney(total)} in total. Most recent: ${str(visits[0], 'workPerformed').toLowerCase()} on ${fmtDate(dateOf(visits[0], 'date'))}.`;
    return finish(text, facts, 0.93, r.technician.id, `${name} at ${where}${when}`);
  }

  if (r.technician && !r.property && !r.equipment && (RX.work.test(qi) || RX.history.test(qi) || window)) {
    const all = visitsFor(ctx, { technicianId: r.technician.id, window });
    noteUnverifiedVisits(ctx, all);
    const visits = answerableVisits(ctx, all);
    const facts: Fact[] = [];
    for (const v of visits.slice(0, 8)) {
      const p = g.entities[str(v, 'propertyId')];
      facts.push(...serviceFacts(ctx, v, `${fmtDate(dateOf(v, 'date'))} — ${str(p, 'address')}`));
    }
    const name = str(r.technician, 'name');
    const when = window ? ` ${window.label}` : '';
    return finish(
      visits.length ? `${name} has ${visits.length} recorded visit${visits.length === 1 ? '' : 's'}${when}. Most recent: ${str(visits[0], 'workPerformed').toLowerCase()} at ${str(g.entities[str(visits[0], 'propertyId')], 'address')} on ${fmtDate(dateOf(visits[0], 'date'))}.` : `${name} has no recorded visits${when}.`,
      facts,
      0.9,
      r.technician.id,
      `${name}'s work${when}`,
    );
  }

  // ---- Equipment-centric (serial / model)
  if (r.equipment) {
    const eq = r.equipment;
    const p = g.entities[str(eq, 'propertyId')];
    const where = p ? str(p, 'address') : 'an unknown location';
    if (RX.warranty.test(qi) || RX.expiring.test(qi)) {
      const info = warrantyStatus(dateOf(eq, 'warrantyExpiry'), now);
      const facts: Fact[] = [];
      push(facts, warrantyFact(ctx, eq));
      push(facts, fact(ctx, eq, 'installDate', 'Installed', { kind: 'date' }));
      if (p) push(facts, fact(ctx, p, 'address', 'Location'));
      const text =
        info.status === 'unknown'
          ? `There is no warranty on file for the ${label(eq)} at ${where}.`
          : info.status === 'expired'
            ? `No — the warranty on the ${label(eq)} at ${where} expired on ${fmtDate(dateOf(eq, 'warrantyExpiry'))}.`
            : `Yes — the ${label(eq)} at ${where} is under warranty until ${fmtDate(dateOf(eq, 'warrantyExpiry'))} (${info.daysRemaining} days left).`;
      return finish(text, facts, 0.95, eq.id, `Warranty for ${str(eq, 'serial')}`);
    }
    if (RX.install.test(qi) || RX.who.test(qi)) {
      const facts: Fact[] = [];
      push(facts, fact(ctx, eq, 'installDate', 'Installed', { kind: 'date' }));
      push(facts, fact(ctx, eq, 'installedByName', 'Installed by'));
      push(facts, fact(ctx, eq, 'model', 'Model'));
      return finish(`${str(eq, 'installedByName')} installed the ${label(eq)} at ${where} on ${fmtDate(dateOf(eq, 'installDate'))}.`, facts, 0.94, eq.id);
    }
    if (RX.lastVisit.test(qi) || RX.work.test(qi) || RX.cost.test(qi)) {
      const all = visitsFor(ctx, { equipmentId: eq.id, window });
      noteUnverifiedVisits(ctx, all);
      const visits = answerableVisits(ctx, all);
      const facts: Fact[] = [];
      const first = visits[0];
      if (RX.cost.test(qi) && !RX.lastVisit.test(qi)) {
        let total = 0;
        for (const v of visits) {
          facts.push(...serviceFacts(ctx, v));
          total += numOf(v, 'cost') ?? 0;
        }
        return finish(visits.length ? `Service on the ${label(eq)} at ${where} has cost ${fmtMoney(total)} across ${visits.length} visit${visits.length === 1 ? '' : 's'}.` : `No billed service is on record for the ${label(eq)} at ${where}.`, facts, 0.9, eq.id);
      }
      for (const v of visits.slice(0, RX.lastVisit.test(qi) ? 1 : 6)) facts.push(...serviceFacts(ctx, v));
      return finish(first ? `The ${label(eq)} at ${where} was last serviced on ${fmtDate(dateOf(first, 'date'))} by ${str(first, 'technicianName')}: ${str(first, 'workPerformed').toLowerCase()}.` : `No service visits are on record for the ${label(eq)} at ${where}.`, facts, 0.92, eq.id);
    }
    // Bare serial / "what is it": the full story
    const facts = equipmentFacts(ctx, eq);
    const visits = answerableVisits(ctx, visitsFor(ctx, { equipmentId: eq.id }));
    noteUnverifiedVisits(ctx, visitsFor(ctx, { equipmentId: eq.id }));
    for (const v of visits.slice(0, 3)) facts.push(...serviceFacts(ctx, v));
    const info = warrantyStatus(dateOf(eq, 'warrantyExpiry'), now);
    const text = `${str(eq, 'serial')} is a ${label(eq)} at ${where}, installed ${fmtDate(dateOf(eq, 'installDate'))} by ${str(eq, 'installedByName')}. Warranty: ${info.label.toLowerCase()}. ${visits.length} service visit${visits.length === 1 ? '' : 's'} on record.`;
    return finish(text, facts, 0.95, eq.id, `Everything on ${str(eq, 'serial')}`);
  }

  // ---- Property-centric (address / customer)
  if (r.property) {
    const p = r.property;
    const address = str(p, 'address');
    let units = equipmentAt(ctx, p.id);
    if (r.equipmentType) units = units.filter((e) => str(e, 'equipmentType') === r.equipmentType);
    if (r.manufacturer) units = units.filter((e) => str(e, 'manufacturer') === r.manufacturer);
    const unitWord = r.equipmentType ? r.equipmentType.toLowerCase() : 'unit';

    if (RX.warranty.test(qi) || RX.expiring.test(qi)) {
      const facts: Fact[] = [];
      for (const e of units) push(facts, fact(ctx, e, 'warrantyExpiry', `${label(e)} warranty`, { value: warrantyStatus(dateOf(e, 'warrantyExpiry'), now).label + (dateOf(e, 'warrantyExpiry') ? ` · ${fmtDate(dateOf(e, 'warrantyExpiry'))}` : ''), status: ({ active: 'ok', expiring: 'warn', expired: 'bad', unknown: 'muted' } as const)[warrantyStatus(dateOf(e, 'warrantyExpiry'), now).status], kind: 'date' }));
      push(facts, fact(ctx, p, 'customerName', 'Customer'));
      const one = units.length === 1 ? units[0] : undefined;
      let text: string;
      if (!units.length) text = `There is no ${unitWord} on record at ${address}.`;
      else if (one) {
        const info = warrantyStatus(dateOf(one, 'warrantyExpiry'), now);
        text =
          info.status === 'unknown'
            ? `There is no warranty on file for the ${label(one)} at ${address}.`
            : info.status === 'expired'
              ? `No — the ${label(one)} at ${address} went out of warranty on ${fmtDate(dateOf(one, 'warrantyExpiry'))}.`
              : `Yes — the ${label(one)} at ${address} is under warranty until ${fmtDate(dateOf(one, 'warrantyExpiry'))} (${info.daysRemaining} days left).`;
      } else {
        const active = units.filter((e) => ['active', 'expiring'].includes(warrantyStatus(dateOf(e, 'warrantyExpiry'), now).status));
        text = `${address} has ${units.length} units on record; ${active.length} ${active.length === 1 ? 'is' : 'are'} still under warranty.`;
      }
      return finish(text, facts, 0.94, p.id, `Warranty at ${address}`);
    }

    if (RX.lastVisit.test(qi) || RX.whoServiced.test(qi)) {
      const all = visitsFor(ctx, { propertyId: p.id, window });
      noteUnverifiedVisits(ctx, all);
      const visits = answerableVisits(ctx, all);
      const last = visits[0];
      const facts: Fact[] = last ? serviceFacts(ctx, last) : [];
      return finish(last ? `We were last at ${address} on ${fmtDate(dateOf(last, 'date'))}: ${str(last, 'technicianName')} did ${str(last, 'workPerformed').toLowerCase()} for ${fmtMoney(numOf(last, 'cost'))}.` : `There is no verified visit on record at ${address}.`, facts, 0.93, p.id, `Last visit to ${address}`);
    }

    if (RX.cost.test(qi)) {
      const all = visitsFor(ctx, { propertyId: p.id, window });
      noteUnverifiedVisits(ctx, all);
      let visits = answerableVisits(ctx, all);
      // "how much did the compressor replacement cost" — narrow to the matching job
      const jobWords = ['compressor', 'blower', 'capacitor', 'thermostat', 'coil', 'filter', 'install', 'audit', 'duct', 'refrigerant', 'freon', 'valve', 'pilot', 'burner', 'motor', 'exchanger', 'startup', 'maintenance', 'inspection'];
      const hit = jobWords.find((w) => q.includes(w));
      if (hit) visits = visits.filter((v) => normalize(str(v, 'workPerformed') + ' ' + str(v, 'notes')).includes(hit));
      const facts: Fact[] = [];
      let total = 0;
      for (const v of visits) {
        facts.push(...serviceFacts(ctx, v));
        total += numOf(v, 'cost') ?? 0;
      }
      const when = window ? ` ${window.label}` : '';
      const one = visits.length === 1 ? visits[0] : undefined;
      const text = one
        ? `The ${str(one, 'workPerformed').toLowerCase()} at ${address} on ${fmtDate(dateOf(one, 'date'))} cost ${fmtMoney(numOf(one, 'cost'))}.`
        : visits.length
          ? `${address} has ${visits.length} billed visits${when} totalling ${fmtMoney(total)}.`
          : `No billed work${hit ? ` matching “${hit}”` : ''} is on record at ${address}${when}.`;
      return finish(text, facts, 0.92, p.id, `Cost at ${address}${when}`);
    }

    if (RX.install.test(qi) || RX.who.test(qi)) {
      const facts: Fact[] = [];
      for (const e of units) {
        push(facts, fact(ctx, e, 'installDate', `${label(e)} installed`, { kind: 'date' }));
        push(facts, fact(ctx, e, 'installedByName', 'Installed by'));
      }
      const one = units.length === 1 ? units[0] : undefined;
      return finish(one ? `${str(one, 'installedByName')} installed the ${label(one)} at ${address} on ${fmtDate(dateOf(one, 'installDate'))}.` : units.length ? `${units.length} units were installed at ${address}: ${units.map((e) => `${label(e)} on ${fmtDate(dateOf(e, 'installDate'))} by ${str(e, 'installedByName')}`).join('; ')}.` : `There is no ${unitWord} on record at ${address}.`, facts, 0.93, p.id);
    }

    // Bare address / customer / "history" — the full story
    const facts: Fact[] = [];
    push(facts, fact(ctx, p, 'address', 'Address'));
    push(facts, fact(ctx, p, 'customerName', 'Customer'));
    for (const e of units) {
      push(facts, fact(ctx, e, 'serial', `${label(e)} serial`, { kind: 'serial' }));
      push(facts, warrantyFact(ctx, e));
    }
    const all = visitsFor(ctx, { propertyId: p.id, window });
    noteUnverifiedVisits(ctx, all);
    const visits = answerableVisits(ctx, all);
    for (const v of visits.slice(0, 4)) facts.push(...serviceFacts(ctx, v));
    const active = units.filter((e) => ['active', 'expiring'].includes(warrantyStatus(dateOf(e, 'warrantyExpiry'), now).status)).length;
    const first = visits[0];
    const text = `${address} (${str(p, 'customerName')}) has ${units.length} unit${units.length === 1 ? '' : 's'} on record, ${active} under warranty, and ${visits.length} service visit${visits.length === 1 ? '' : 's'}${first ? `, most recently ${fmtDate(dateOf(first, 'date'))}` : ''}.`;
    return finish(text, facts, 0.94, p.id, `Everything on ${address}`);
  }

  // ---- Fleet-level lists without a property: "all Carrier units", "how many furnaces", "which units did David Chen install"
  if (r.manufacturer || r.equipmentType || (r.technician && RX.install.test(qi))) {
    let units = entitiesOfType(g, 'equipment');
    if (r.manufacturer) units = units.filter((e) => str(e, 'manufacturer') === r.manufacturer);
    if (r.equipmentType) units = units.filter((e) => str(e, 'equipmentType') === r.equipmentType);
    if (r.technician) units = units.filter((e) => str(e, 'installedBy') === r.technician?.id);
    const facts: Fact[] = [];
    for (const e of units) {
      const p = g.entities[str(e, 'propertyId')];
      push(facts, fact(ctx, e, 'serial', `${label(e)} — ${str(p, 'address')}`, { kind: 'serial' }));
    }
    const scope = [r.manufacturer, r.equipmentType ? r.equipmentType.toLowerCase() : 'unit'].filter(Boolean).join(' ');
    const by = r.technician ? ` installed by ${str(r.technician, 'name')}` : '';
    return finish(units.length ? `You have ${units.length} ${scope}${units.length === 1 ? '' : 's'}${by} on record.` : `No ${scope}s${by} are on record.`, facts, 0.9, undefined, `${scope}s${by}`);
  }

  return noAnswer('Nothing in your records answers that. Here are the closest documents.', closestDocs(ctx, q));
}
