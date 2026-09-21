/**
 * Property management domain — SCAFFOLD. See
 * src/domains/electrical/index.ts's header for the scope decision (no
 * seed/answer/intake yet) — the same applies here, more so: this vertical's
 * ICP (a property manager, not a trade-business owner) and entity model
 * (unit/lease/tenant/vendor) are the furthest from hvac's, so a real
 * seed/answer/intake here is a bigger lift than for electrical or plumbing.
 * Not imported by main.tsx, App.tsx or any screen — only by ../registry.ts.
 */
export { propertySchema } from './schema';
export * from './documentTypes';
export * from './units';
export * from './rules';
