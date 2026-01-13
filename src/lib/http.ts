type HeadersRecord = Record<string, string | undefined>;

function getAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseAllowedOrigins(): string[] {
  return getAllowedOrigins();
}

export function isOriginAllowed(originHeader?: string): boolean {
  const allowed = getAllowedOrigins();
  if (!allowed.length) return true;  // No restrictions if not configured
  if (!originHeader) {
    console.log(`[http] Origin check: no origin header, ALLOWED_ORIGINS=${process.env.ALLOWED_ORIGINS}`);
    return false;
  }
  try {
    const validated = new URL(originHeader).origin;
    const isAllowed = allowed.includes(validated);
    if (!isAllowed) {
      console.log(`[http] Origin rejected: "${validated}" not in [${allowed.join(', ')}]`);
    }
    return isAllowed;
  } catch {
    console.log(`[http] Origin check failed to parse: "${originHeader}"`);
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

export function corsHeaders(originHeader?: string, methods = "GET, POST, OPTIONS") {
  const allowed = getAllowedOrigins();
  const allowedOrigin =
    originHeader && isOriginAllowed(originHeader) ? originHeader : allowed[0] || "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  } as Record<string, string>;
}

export function json(
  statusCode: number,
  body: unknown,
  originHeader?: string,
  methods = "GET, POST, OPTIONS",
  extraHeaders: Record<string, string> = {}
) {
  return {
    statusCode,
    headers: { ...corsHeaders(originHeader, methods), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export function jsonResponse(
  statusCode: number,
  body: unknown,
  originHeader: string | undefined,
  methods: string,
  extraHeaders: Record<string, string> = {}
) {
  return json(statusCode, body, originHeader, methods, extraHeaders);
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

export function isUserMode(): boolean {
  const mode = (process.env.AUTH_MODE || "admin").toLowerCase();
  return mode === "user" || mode === "mixed";
}
