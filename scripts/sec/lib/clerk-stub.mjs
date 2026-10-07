// Offline stand-in for @clerk/backend. verifyToken decodes a base64url JSON "claims" token minted by harness.mintToken().
// Rejects: not 3 parts-less format, expired (exp in past), tampered ("bad" signature), wrong azp. Clerk's own crypto is NOT under test.
export async function verifyToken(token, opts = {}) {
  const [tag, body, sig] = String(token).split('.');
  if (tag !== 'stub' || sig !== 'ok') throw new Error('stub: malformed/unsigned token');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new Error('stub: token expired');
  if (opts.authorizedParties && claims.azp && !opts.authorizedParties.includes(claims.azp)) throw new Error('stub: bad azp');
  return claims;
}
export const createClerkClient = () => ({ users: {}, organizations: {} });
export const clerkClient = createClerkClient();
export default { verifyToken, createClerkClient };
