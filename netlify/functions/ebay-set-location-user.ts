import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { tokensStore } from "../../src/lib/redis-store.js";
import { userScopedKey } from "../../src/lib/_auth.js";

const METHODS = "POST, OPTIONS";

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") return json(200, {}, originHdr, METHODS);
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" }, originHdr, METHODS);
  if (!isOriginAllowed(originHdr)) return json(403, { error: "Forbidden" }, originHdr, METHODS);

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  const ctype = headers["content-type"] || headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) return json(415, { error: "Use application/json" }, originHdr, METHODS);

  let body: any = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" }, originHdr, METHODS);
  }

  const key = typeof body?.merchantLocationKey === "string" ? body.merchantLocationKey.trim() : "";
  if (!key) return json(400, { error: "Missing merchantLocationKey" }, originHdr, METHODS);

  try {
    const store = tokensStore();
    await store.setJSON(userScopedKey(user.userId, "ebay-location.json"), { merchantLocationKey: key, updatedAt: Date.now() });
  } catch (err: any) {
    return json(500, { error: "persist_failed", detail: err?.message || String(err ?? "") }, originHdr, METHODS);
  }

  return json(200, { ok: true, merchantLocationKey: key }, originHdr, METHODS);
};
