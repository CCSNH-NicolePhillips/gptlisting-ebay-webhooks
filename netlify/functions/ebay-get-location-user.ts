import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, json } from "../../src/lib/http.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";

const METHODS = "GET, OPTIONS";

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") return json(200, {}, originHdr, METHODS);
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" }, originHdr, METHODS);

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  try {
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(user.userId, "ebay-location.json"), { type: "json" })) as any;
    const merchantLocationKey = typeof saved?.merchantLocationKey === "string" ? saved.merchantLocationKey.trim() : "";
    return json(200, { ok: true, merchantLocationKey }, originHdr, METHODS);
  } catch (err: any) {
    return json(500, { error: "read_failed", detail: err?.message || String(err ?? "") }, originHdr, METHODS);
  }
};
