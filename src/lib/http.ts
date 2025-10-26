type HeadersRecord = Record<string, string | undefined>;

export function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isOriginAllowed(originHeader?: string): boolean {
  const allow = parseAllowedOrigins();
  if (!allow.length) return true;
  if (!originHeader) return false;
  try {
    const validated = new URL(originHeader).origin;
    return allow.includes(validated);
  } catch {
    return false;
  }
}

export function getOrigin(headers: HeadersRecord): string | undefined {
  const origin =
    headers["origin"] ||
    headers["Origin"] ||
    headers["access-control-request-origin"] ||
    headers["Access-Control-Request-Origin"];

  if (origin) return origin;

  const referer = headers["referer"] || headers["Referer"];
  if (!referer) return undefined;

  try {
    // Browsers skip the Origin header on same-origin requests, but Referer still exposes it.
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export function corsHeaders(originHeader: string | undefined, methods: string) {
  const allow = parseAllowedOrigins();
  const allowedOrigin =
    originHeader && isOriginAllowed(originHeader) ? originHeader : allow[0] || "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  } as Record<string, string>;
}

export function jsonResponse(
  statusCode: number,
  body: unknown,
  originHeader: string | undefined,
  methods: string
) {
  return {
    statusCode,
    headers: corsHeaders(originHeader, methods),
    body: JSON.stringify(body),
  };
}

export function extractBearerToken(headers: HeadersRecord): string {
  const raw = headers["authorization"] || headers["Authorization"] || "";
  if (!raw.startsWith("Bearer ")) return "";
  return raw.slice("Bearer ".length).trim();
}

export function isAuthorized(headers: HeadersRecord): boolean {
  const adminToken = process.env.ADMIN_API_TOKEN || "";
  if (!adminToken) return true;
  const token = extractBearerToken(headers);
  return Boolean(token) && token === adminToken;
}
