import { createRemoteJWKSet, jwtVerify } from "jose";

const MODE = (process.env.AUTH_MODE || "admin").toLowerCase();
const DOMAIN = process.env.AUTH0_DOMAIN || "";
const ISS = DOMAIN ? `https://${DOMAIN}/` : "";
const AUD = process.env.AUTH0_AUDIENCE || undefined;
const CLIENT = process.env.AUTH0_CLIENT_ID || undefined;

let JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
if (DOMAIN) {
  JWKS = createRemoteJWKSet(new URL(`${ISS}.well-known/jwks.json`));
}

export type UserAuth = { userId: string };

export async function maybeRequireUserAuth(authHeader?: string): Promise<UserAuth | null> {
  if (MODE !== "user" && MODE !== "mixed") return null;
  
  if (!JWKS) {
    throw new Error("Auth0 not configured (missing AUTH0_DOMAIN)");
  }
  
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }
  
  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Authorization header must start with 'Bearer '");
  }

  const token = authHeader.slice(7).trim();
  
  if (!token) {
    throw new Error("Authorization header contains empty token");
  }
  
  const audiences = [AUD, CLIENT].filter(Boolean) as string[];
  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    issuer: ISS || undefined,
  };
  if (audiences.length === 1) verifyOptions.audience = audiences[0];
  else if (audiences.length > 1) verifyOptions.audience = audiences;

  try {
    const { payload } = await jwtVerify(token, JWKS, verifyOptions);

    const sub = String(payload.sub || "").trim();
    if (!sub) {
      throw new Error("Token missing 'sub' claim");
    }

    return { userId: sub };
  } catch (err: any) {
    // Provide specific error messages for common JWT validation failures
    if (err.code === 'ERR_JWT_EXPIRED') {
      throw new Error(`Token expired at ${err.claim}`);
    }
    if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      throw new Error(`JWT claim validation failed: ${err.claim} (reason: ${err.reason})`);
    }
    if (err.message?.includes('audience')) {
      throw new Error(`Invalid audience - expected: ${audiences.join(' or ')}, got: ${err.claim || 'unknown'}`);
    }
    if (err.message?.includes('issuer')) {
      throw new Error(`Invalid issuer - expected: ${ISS}, got: ${err.claim || 'unknown'}`);
    }
    // Re-throw with more context
    throw new Error(`Token validation failed: ${err.message || String(err)}`);
  }
}

export async function requireUserAuth(authHeader?: string): Promise<UserAuth> {
  if (MODE !== "user" && MODE !== "mixed") {
    throw new Error("User authentication not enabled (AUTH_MODE must be 'user' or 'mixed')");
  }

  const auth = await maybeRequireUserAuth(authHeader);
  if (!auth) {
    throw new Error("Authentication failed - no user returned");
  }
  return auth;
}

/** Same as requireUserAuth but also returns the full JWT claims (email, name, etc.) */
export async function requireUserAuthFull(
  authHeader?: string,
): Promise<{ userId: string; claims: Record<string, unknown> }> {
  if (MODE !== "user" && MODE !== "mixed") {
    throw new Error("User authentication not enabled (AUTH_MODE must be 'user' or 'mixed')");
  }
  if (!JWKS) {
    throw new Error("Auth0 not configured (missing AUTH0_DOMAIN)");
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7).trim();
  if (!token) throw new Error("Empty bearer token");

  const audiences = [AUD, CLIENT].filter(Boolean) as string[];
  const verifyOptions: Parameters<typeof jwtVerify>[2] = { issuer: ISS || undefined };
  if (audiences.length === 1) verifyOptions.audience = audiences[0];
  else if (audiences.length > 1) verifyOptions.audience = audiences;

  const { payload } = await jwtVerify(token, JWKS, verifyOptions);
  const sub = String(payload.sub ?? "").trim();
  if (!sub) throw new Error("Token missing 'sub' claim");
  return { userId: sub, claims: payload as Record<string, unknown> };
}
