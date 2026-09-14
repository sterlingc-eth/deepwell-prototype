/**
 * Server-side request authentication.
 *
 * Every api/ handler must call requireAuth() before doing any work. The UI gate
 * in src/App.tsx protects only the UI; these functions are a separate, publicly
 * reachable surface and have to verify the caller themselves.
 *
 * The tenant is derived from the verified token and is never read from the
 * request body — otherwise any caller could name any tenant and read their data.
 */
import { verifyToken } from "@clerk/backend";

/** Origins whose tokens this API will accept. */
const AUTHORIZED_PARTIES = [
  "https://deepwellinc.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
];

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/**
 * @returns {Promise<{userId: string, orgId: string|null, tenantId: string}>}
 * @throws {AuthError}
 */
export async function requireAuth(req) {
  const header = req?.headers?.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new AuthError("Sign in required");

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    // Misconfiguration, not a client error — but never hand the caller detail.
    console.error("CLERK_SECRET_KEY is not set; refusing all API requests.");
    throw new AuthError("Server is not configured for authentication", 500);
  }

  let claims;
  try {
    claims = await verifyToken(token, {
      secretKey,
      // Without this, ANY token minted by this Clerk instance is accepted —
      // including one issued to a different frontend or a JWT template.
      authorizedParties: AUTHORIZED_PARTIES,
    });
  } catch (err) {
    console.error("Token verification failed:", err?.message);
    throw new AuthError("Session is invalid or has expired");
  }

  const userId = claims.sub;
  if (!userId) throw new AuthError("Session is invalid or has expired");

  // Clerk organizations become the tenant once they're enabled. Until then each
  // user is their own tenant, so isolation holds either way and turning
  // organizations on later does not change this contract.
  const orgId = claims.org_id ?? null;
  return { userId, orgId, tenantId: orgId ?? `user_${userId}` };
}

/** Uniform 401/500 response. Never leaks internals to the caller. */
export function denyAuth(res, err) {
  const status = err?.status ?? 401;
  return res.status(status).json({ error: err?.message ?? "Sign in required" });
}
