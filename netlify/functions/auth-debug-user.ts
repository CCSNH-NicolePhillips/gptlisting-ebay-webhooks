import type { Handler } from '../../src/types/api-handler.js';
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Minimal debug endpoint to help diagnose 401s for user endpoints.
// Returns expected issuer/audiences and a decoded (UNVERIFIED) token header/payload.
// Requires Authorization header and allowed origin.

function safeDecodeJwt(token: string): { header?: any; payload?: any } {
  try {
    const [h, p] = token.split(".");
    const toObj = (b64: string) => JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return { header: toObj(h), payload: toObj(p) };
  } catch {
    return {};
  }
}

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);
  const methods = "GET, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return json(403, { error: "Forbidden" }, originHdr, methods);
  }

  const auth = headers["authorization"] || headers["Authorization"] || "";
  if (!auth.startsWith("Bearer ")) {
    return json(401, { error: "Missing bearer" }, originHdr, methods);
  }

  const token = auth.slice(7).trim();
  const decoded = safeDecodeJwt(token);

  const mode = (process.env.AUTH_MODE || "admin").toLowerCase();
  const domain = process.env.AUTH0_DOMAIN || "";
  const issuer = domain ? `https://${domain}/` : undefined;
  const expectedAudiences = [process.env.AUTH0_AUDIENCE, process.env.AUTH0_CLIENT_ID].filter(Boolean);

  // Attempt verification with current server settings to surface the precise failure
  let verify: any = { ok: false };
  try {
    if (!issuer) throw new Error("Issuer not configured");
    const JWKS = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
    const opts: Parameters<typeof jwtVerify>[2] = { issuer };
    if (expectedAudiences.length === 1) opts.audience = expectedAudiences[0] as string;
    else if (expectedAudiences.length > 1) opts.audience = expectedAudiences as any;
    const result = await jwtVerify(token, JWKS, opts);
    verify = { ok: true, subject: result.payload?.sub || null, aud: result.payload?.aud || null };
  } catch (e: any) {
    verify = { ok: false, error: e?.message || String(e), name: e?.name || undefined };
  }

  const body = {
    ok: true,
    mode,
    issuerExpected: issuer,
    audiencesExpected: expectedAudiences,
    tokenHeader: decoded.header || null,
    tokenClaims: decoded.payload || null,
    verify,
  };

  return json(200, body, originHdr, methods);
};
