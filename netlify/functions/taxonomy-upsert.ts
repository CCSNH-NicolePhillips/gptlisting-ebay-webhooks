import type { Handler } from "@netlify/functions";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import type { CategoryDef, ItemSpecific } from "../../src/lib/taxonomy-schema.js";
import { putCategory } from "../../src/lib/taxonomy-store.js";

const METHODS = "POST, OPTIONS";

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function coerceItemSpecifics(input: unknown): ItemSpecific[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((spec) => (typeof spec === "object" && spec ? spec : null))
    .filter((spec): spec is Record<string, unknown> => Boolean(spec))
    .map((spec) => ({
      name: String(spec.name ?? "").trim(),
      type: (spec.type === "enum" ? "enum" : "string") as ItemSpecific["type"],
      enum: Array.isArray(spec.enum) ? spec.enum.map((entry) => String(entry)) : undefined,
      source: (spec.source === "static" ? "static" : "group") as ItemSpecific["source"],
      from: typeof spec.from === "string" ? (spec.from as ItemSpecific["from"]) : undefined,
      static: typeof spec.static === "string" ? spec.static : undefined,
      required: Boolean(spec.required),
    }))
    .filter((spec) => Boolean(spec.name));
}

function normalizeCondition(value: unknown): CategoryDef["defaults"] extends { condition?: infer C }
  ? C
  : undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  if (upper === "NEW" || upper === "USED" || upper === "LIKE_NEW") {
    return upper as CategoryDef["defaults"] extends { condition?: infer C } ? C : never;
  }
  return undefined;
}

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  let body: any = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" }, originHdr, METHODS);
  }

  const id = String(body.id ?? "").trim();
  const slugInput = String(body.slug ?? id ?? "").trim();
  const marketplaceId = String(body.marketplaceId ?? "").trim();
  const title = String(body.title ?? "").trim();

  if (!id || !slugInput || !marketplaceId || !title) {
    return jsonResponse(400, { error: "Missing required fields" }, originHdr, METHODS);
  }

  const slug = normalizeSlug(slugInput);
  const now = Date.now();
  const version = Number(body.version ?? 1) || 1;

  const cat: CategoryDef = {
    id,
    slug,
    title,
    marketplaceId,
    scoreRules: body.scoreRules && typeof body.scoreRules === "object" ? {
      includes: Array.isArray(body.scoreRules.includes)
        ? body.scoreRules.includes.map((entry: unknown) => String(entry)).filter(Boolean)
        : undefined,
      excludes: Array.isArray(body.scoreRules.excludes)
        ? body.scoreRules.excludes.map((entry: unknown) => String(entry)).filter(Boolean)
        : undefined,
      minScore: Number(body.scoreRules.minScore ?? body.scoreRules.minScore) || undefined,
    } : undefined,
    itemSpecifics: coerceItemSpecifics(body.itemSpecifics),
    defaults:
      body.defaults && typeof body.defaults === "object"
        ? {
            condition: normalizeCondition(body.defaults.condition),
            quantity: Number(body.defaults.quantity ?? 0) || undefined,
            fulfillmentPolicyId: body.defaults.fulfillmentPolicyId
              ? String(body.defaults.fulfillmentPolicyId)
              : undefined,
            paymentPolicyId: body.defaults.paymentPolicyId ? String(body.defaults.paymentPolicyId) : undefined,
            returnPolicyId: body.defaults.returnPolicyId ? String(body.defaults.returnPolicyId) : undefined,
          }
        : undefined,
    version,
    updatedAt: now,
  };

  await putCategory(cat);
  return jsonResponse(200, { ok: true, slug: cat.slug, version: cat.version }, originHdr, METHODS);
};
