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
  if (!JWKS) throw new Error("Auth0 not configured");
  if (!authHeader?.startsWith("Bearer ")) throw new Error("unauthorized");

  const token = authHeader.slice(7).trim();
  const audiences = [AUD, CLIENT].filter(Boolean) as string[];
  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    issuer: ISS || undefined,
  };
  if (audiences.length === 1) verifyOptions.audience = audiences[0];
  else if (audiences.length > 1) verifyOptions.audience = audiences;

  const { payload } = await jwtVerify(token, JWKS, verifyOptions);

  const sub = String(payload.sub || "").trim();
  if (!sub) throw new Error("unauthorized");

  return { userId: sub };
}

export async function requireUserAuth(authHeader?: string): Promise<UserAuth> {
  if (MODE !== "user" && MODE !== "mixed") {
    throw new Error("unauthorized");
  }

  const auth = await maybeRequireUserAuth(authHeader);
  if (!auth) throw new Error("unauthorized");
  return auth;
}
