/**
 * "Try asking" suggestions for AskScreen.
 *
 * These used to be six hardcoded questions naming fake addresses and a fake
 * serial number — invented demo content shown to real contractors on a real
 * account. Every suggestion here instead names something that actually
 * exists in the graph: a property this tenant ingested, a serial this tenant
 * ingested. When the graph has nothing yet, the caller is expected to show
 * clearly-labelled examples instead of calling this at all — see AskScreen.
 */
import type { Entity } from './types';
import { str } from './answer';

export const MAX_SUGGESTIONS = 5;

/**
 * Builds up to `max` real questions from the entities on hand. Pure and
 * order-preserving (same entities in, same suggestions out) so it is
 * directly unit-testable — no store, no React.
 */
export function buildSuggestions(entities: Entity[], max: number = MAX_SUGGESTIONS): string[] {
  const out: string[] = [];
  const push = (q: string | null | undefined) => {
    if (q && !out.includes(q) && out.length < max) out.push(q);
  };

  const properties = entities.filter((e) => e.type === 'property');
  const equipment = entities.filter((e) => e.type === 'equipment');

  for (const p of properties) {
    if (out.length >= max) break;
    const address = str(p, 'address');
    if (address) push(`When were we last at ${address}?`);
  }

  for (const e of equipment) {
    if (out.length >= max) break;
    const serial = str(e, 'serial');
    if (serial) push(`Is ${serial} still under warranty?`);
  }

  for (const p of properties) {
    if (out.length >= max) break;
    const customer = str(p, 'customerName');
    if (!customer) continue;
    const address = str(p, 'address');
    push(`What do we have on file for ${customer}${address ? ` at ${address}` : ''}?`);
  }

  if (equipment.length > 0) push('Which warranties expire in the next 12 months?');

  return out.slice(0, max);
}
