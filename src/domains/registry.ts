/**
 * Domain registry — lists every DomainSchema DeepWell knows about.
 *
 * This is the "registered wherever hvac is registered" point for the three
 * new scaffolds (electrical, plumbing, property — see
 * handoffs/INDUSTRY_EXPANSION_2026-09-21.md). It is NOT a live switch: there
 * is no domain-switcher UI in DeepWell today. hvacSchema is hardcoded
 * directly into the real pipeline (src/hooks/usePostgresSync.ts imports it
 * by name, as do several screens), and src/main.tsx only ever bootstraps the
 * hvac demo fixture, gated by VITE_DEMO_MODE. Nothing in the running app
 * imports this file — main.tsx, App.tsx and every screen are unchanged.
 *
 * Its purpose is discovery for whenever a real domain switch is built: that
 * work would read DOMAINS (or DOMAINS_BY_ID) instead of hardcoding hvacSchema
 * the way today's pipeline does, and would need to decide what "selectable"
 * means (per-tenant config? a plan entitlement?) — out of scope here.
 */
import { hvacSchema } from './hvac';
import { electricalSchema } from './electrical';
import { plumbingSchema } from './plumbing';
import { propertySchema } from './property';
import type { DomainSchema } from '../core/types';

export const DOMAINS: DomainSchema[] = [hvacSchema, electricalSchema, plumbingSchema, propertySchema];

export const DOMAINS_BY_ID: Record<string, DomainSchema> = Object.fromEntries(
  DOMAINS.map((d) => [d.id, d]),
);

/** Only hvac ships today — the rest are scaffolds pending a domain switch. */
export const LIVE_DOMAIN_IDS: ReadonlySet<string> = new Set(['hvac']);

export function isDomainLive(id: string): boolean {
  return LIVE_DOMAIN_IDS.has(id);
}
