import type { Handler } from '../../src/types/api-handler.js';
import {
  bindListing,
  getBindingsForJob,
  getListingBinding,
  removeBinding,
} from "../../src/lib/price-store.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

type HeadersMap = Record<string, string | undefined>;
const METHODS = "GET, POST, DELETE, OPTIONS";

function normalizeStringInput(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const str = typeof value === "string" ? value : String(value ?? "");
  const trimmed = str.trim();
  return trimmed ? trimmed : null;
}

function coerceOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function coerceOptionalTimestamp(value: unknown): number | undefined {
  const num = coerceOptionalNumber(value);
  return num !== undefined ? Math.trunc(num) : undefined;
}

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  if (event.httpMethod === "GET") {
    const jobId = (event.queryStringParameters?.jobId || "").trim();
    const groupId = (event.queryStringParameters?.groupId || "").trim();
    if (!jobId) {
      return jsonResponse(400, { error: "Missing jobId" }, originHdr, METHODS);
    }
    try {
      if (groupId) {
        const binding = await getListingBinding(jobId, groupId);
        if (!binding) {
          return jsonResponse(404, { error: "Binding not found" }, originHdr, METHODS);
        }
        return jsonResponse(200, { ok: true, binding }, originHdr, METHODS);
      }
      const bindings = await getBindingsForJob(jobId);
      return jsonResponse(200, { ok: true, count: bindings.length, bindings }, originHdr, METHODS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: "Failed to load bindings", detail: message }, originHdr, METHODS);
    }
  }

  if (event.httpMethod === "POST") {
    let payload: any;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { error: "Invalid JSON" }, originHdr, METHODS);
    }

    const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
    const groupId = typeof payload.groupId === "string" ? payload.groupId.trim() : "";
    const userId = typeof payload.userId === "string" ? payload.userId.trim() : "";

    if (!jobId || !groupId || !userId) {
      return jsonResponse(400, { error: "jobId, groupId, and userId are required" }, originHdr, METHODS);
    }

    const offerId = normalizeStringInput(payload.offerId);
    const listingId = normalizeStringInput(payload.listingId);
    const sku = normalizeStringInput(payload.sku);
    const currentPrice = coerceOptionalNumber(payload.currentPrice);
    const lastReductionAt = coerceOptionalTimestamp(payload.lastReductionAt);
    const autoField = payload.auto === null ? null : payload.auto;

    try {
      const binding = await bindListing({
        jobId,
        groupId,
        userId,
        offerId,
        listingId,
        sku,
        currentPrice,
        pricing: payload.pricing && typeof payload.pricing === "object" ? payload.pricing : undefined,
        auto: autoField && typeof autoField === "object" ? autoField : autoField,
        metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : undefined,
        lastReductionAt,
      });
      return jsonResponse(200, { ok: true, binding }, originHdr, METHODS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: "Failed to bind listing", detail: message }, originHdr, METHODS);
    }
  }

  if (event.httpMethod === "DELETE") {
    let payload: any;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { error: "Invalid JSON" }, originHdr, METHODS);
    }

    const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
    const groupId = typeof payload.groupId === "string" ? payload.groupId.trim() : "";
    if (!jobId || !groupId) {
      return jsonResponse(400, { error: "jobId and groupId are required" }, originHdr, METHODS);
    }

    try {
      const removed = await removeBinding(jobId, groupId);
      return jsonResponse(200, { ok: true, removed }, originHdr, METHODS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: "Failed to remove binding", detail: message }, originHdr, METHODS);
    }
  }

  return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
};
