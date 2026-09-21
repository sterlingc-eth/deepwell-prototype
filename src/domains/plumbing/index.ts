/**
 * Plumbing domain — SCAFFOLD. See src/domains/electrical/index.ts's header
 * for the scope decision (no seed/answer/intake yet) — the same applies here.
 * Not imported by main.tsx, App.tsx or any screen — only by ../registry.ts.
 */
export { plumbingSchema } from './schema';
export * from './documentTypes';
export * from './units';
export * from './rules';
