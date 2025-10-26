import type { Handler } from "@netlify/functions";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { getCategory } from "../../src/lib/taxonomy-store.js";

const METHODS = "GET, OPTIONS";

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  const slug = (event.queryStringParameters?.slug || "").trim();
  if (!slug) {
    return jsonResponse(400, { error: "Missing slug" }, originHdr, METHODS);
  }

  const category = await getCategory(slug);
  if (!category) {
    return jsonResponse(404, { error: "Category not found" }, originHdr, METHODS);
  }

  return jsonResponse(200, category, originHdr, METHODS);
};
