import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";

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

  const body = {
    ok: true,
    mode,
    issuerExpected: issuer,
    audiencesExpected: expectedAudiences,
    tokenHeader: decoded.header || null,
    tokenClaims: decoded.payload || null,
  };

  return json(200, body, originHdr, methods);
};
