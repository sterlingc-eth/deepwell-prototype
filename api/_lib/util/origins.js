/**
 * The browser origins that may call this API. ONE list, used by both CORS (claude.js handleCors) and Clerk's
 * authorizedParties (auth.js), so an origin can never be authorized for tokens but blocked by CORS (or the
 * reverse) because two copies drifted (R30 L6).
 */
export const APP_ORIGINS = Object.freeze([
  "https://deepwellinc.vercel.app",
  "https://deepwelltechnology.com",
  "https://www.deepwelltechnology.com",
  "http://localhost:5173",
  "http://localhost:4173",
]);
