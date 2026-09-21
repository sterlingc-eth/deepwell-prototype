/**
 * Electrical domain — SCAFFOLD. See handoffs/INDUSTRY_EXPANSION_2026-09-21.md.
 *
 * Deliberately narrower than hvac's index.ts: hvac also has seed.ts (a demo
 * fixture), answer.ts (the mock Q&A engine) and intake.ts (file-classify
 * helpers for the demo upload flow). Those implement a *working* domain end
 * to end; this scaffold only covers what the brief asked for — schema,
 * documentTypes, units and rules that type-check — because building a real
 * seed/answer/intake for electrical means fabricating a second corpus and
 * duplicating the answer engine for a vertical nobody has sold yet. That's
 * follow-on work if/when electrical is greenlit (see the handoff's
 * recommended order), not part of this scaffold.
 *
 * Not imported by main.tsx, App.tsx or any screen — only by
 * ../registry.ts, which itself is not imported by the running app. See the
 * registry file for why.
 */
export { electricalSchema } from './schema';
export * from './documentTypes';
export * from './units';
export * from './rules';
