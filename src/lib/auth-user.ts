import { createRemoteJWKSet, jwtVerify } from "jose";

const MODE = (process.env.AUTH_MODE || "admin").toLowerCase();
const DOMAIN = process.env.AUTH0_DOMAIN || "";
const ISS = DOMAIN ? `https://${DOMAIN}/` : "";
const AUD = process.env.AUTH0_AUDIENCE || undefined;

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
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ISS || undefined,
    audience: AUD,
  });

  const sub = String(payload.sub || "").trim();
  if (!sub) throw new Error("unauthorized");

  return { userId: sub };
}
