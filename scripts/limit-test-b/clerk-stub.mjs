// Mock of @clerk/backend for the limit tests (no network, no real Clerk). Tokens are base64url(JSON claims);
// verifyToken rejects: not-JSON, missing sub, expired (exp < now), or {__forged:true} (bad signature).
export async function verifyToken(token, opts) {
  if (!opts?.secretKey) throw new Error('no secret key');
  let c;
  try { c = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8')); } catch { throw new Error('Invalid JWT form'); }
  if (!c || typeof c !== 'object') throw new Error('Invalid JWT');
  if (c.__forged) throw new Error('signature verification failed');
  if (typeof c.exp === 'number' && c.exp < Date.now() / 1000) throw new Error('token expired');
  if (typeof c.nbf === 'number' && c.nbf > Date.now() / 1000) throw new Error('token not yet valid');
  return c;
}
export function createClerkClient() { return globalThis.__clerkFake ?? {}; }
