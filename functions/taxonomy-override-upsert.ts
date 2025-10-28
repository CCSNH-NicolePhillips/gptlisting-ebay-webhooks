import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../src/lib/http.js";
import { k } from "../src/lib/user-keys.js";

type UpstashResponse<T = unknown> = { result?: T; error?: string };

const UPSTASH_BASE = process.env.UPSTASH_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstash<T = unknown>(cmd: any[]): Promise<UpstashResponse<T>> {
  if (!UPSTASH_BASE || !UPSTASH_TOKEN) return { error: "Upstash not configured" };
  const r = await fetch(UPSTASH_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) {
    return { error: `Upstash ${r.status}` };
  }
  return (await r.json()) as UpstashResponse<T>;
}

export const handler: Handler = async (ev) => {
  try {
    const headers = ev.headers as Record<string, string | undefined>;
    const originHdr = getOrigin(headers);
    const methods = "POST, OPTIONS";

    if (ev.httpMethod === "OPTIONS") return json(200, {}, originHdr, methods);
    if (ev.httpMethod !== "POST") return json(405, { error: "Method not allowed" }, originHdr, methods);
    if (!isOriginAllowed(originHdr)) return json(403, { error: "Forbidden" }, originHdr, methods);

    let user;
    try {
      user = await requireUserAuth(headers.authorization || headers.Authorization);
    } catch {
      return json(401, { error: "Unauthorized" }, originHdr, methods);
    }

    const ctype = headers["content-type"] || headers["Content-Type"] || "";
    if (!ctype.includes("application/json")) return json(415, { error: "Use application/json" }, originHdr, methods);

    let body: any = {};
    try {
      body = JSON.parse(ev.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" }, originHdr, methods);
    }

    const { jobId, groupId, aspects, categoryId } = body;
    if (!jobId || !groupId) return json(400, { error: "Missing jobId or groupId" }, originHdr, methods);

  const key = k.override(user.userId, jobId, groupId);
    const record: any = {
      inventory: { product: { aspects: aspects || {} } },
    };
    if (categoryId) {
      record.offer = { categoryId };
      record._meta = { selectedCategory: { id: categoryId, slug: String(categoryId), title: String(categoryId) } };
    }

    const setRes = await upstash(["SET", key, JSON.stringify(record)]);
    if (setRes.error) return json(500, { error: "override_upsert_failed", detail: setRes.error }, originHdr, methods);

    return json(200, { ok: true }, originHdr, methods);
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "unexpected", detail: { message: err?.message, stack: err?.stack } }),
    };
  }
};
