/**
 * Bridges Clerk's session token from React into the plain-TS service layer.
 *
 * The services below are not components and cannot call useAuth(), so App
 * registers Clerk's getToken here once and the services read it per request.
 * Tokens are short-lived, so we always ask for a fresh one rather than caching.
 */
type TokenProvider = () => Promise<string | null>;

let provider: TokenProvider | null = null;

export function setAuthTokenProvider(fn: TokenProvider | null): void {
  provider = fn;
}

/** Authorization header for an API call, or {} when signed out. */
export async function authHeader(): Promise<Record<string, string>> {
  if (!provider) return {};
  try {
    const token = await provider();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
