import type { Handler } from '../../src/types/api-handler.js';
import { getListingBinding, updateBinding } from "../../src/lib/price-store.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { maybeRequireUserAuth, type UserAuth } from "../../src/lib/auth-user.js";

type HeadersMap = Record<string, string | undefined>;
const METHODS = "POST, OPTIONS";

/**
 * POST /price-reduction-update
 * 
 * Updates the auto price reduction settings for a specific binding.
 * 
 * Body:
 *   - jobId: string (required)
 *   - groupId: string (required)
 *   - auto: { reduceBy, everyDays, minPrice } | null (to disable)
 */

interface UpdateRequest {
  jobId: string;
  groupId: string;
  auto: {
    reduceBy: number;
    everyDays: number;
    minPrice: number;
  } | null;
}

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  // Auth check - try admin token first, then user auth
  let userAuth: UserAuth | null = null;
  if (!isAuthorized(headers)) {
    try {
      userAuth = await maybeRequireUserAuth(headers.authorization || headers.Authorization);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err ?? "");
      console.warn("[price-reduction-update] user auth failed", reason);
      return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
    }
    if (!userAuth) {
      return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
    }
  }

  try {
    const userId = userAuth?.userId;
    if (!userId) {
      return jsonResponse(401, { error: "User ID required" }, originHdr, METHODS);
    }

    // Parse body
    const body: UpdateRequest = JSON.parse(event.body || "{}");
    
    if (!body.jobId || !body.groupId) {
      return jsonResponse(400, { error: "jobId and groupId are required" }, originHdr, METHODS);
    }

    // Get existing binding
    const existing = await getListingBinding(body.jobId, body.groupId);
    
    if (!existing) {
      return jsonResponse(404, { error: "Binding not found" }, originHdr, METHODS);
    }
    
    // Verify ownership
    if (existing.userId !== userId) {
      return jsonResponse(403, { error: "Not authorized to update this binding" }, originHdr, METHODS);
    }

    // Validate auto config if provided
    let autoConfig = body.auto;
    if (autoConfig !== null) {
      if (typeof autoConfig.reduceBy !== 'number' || autoConfig.reduceBy <= 0 || autoConfig.reduceBy > 100) {
        return jsonResponse(400, { error: "reduceBy must be between 0.01 and 100" }, originHdr, METHODS);
      }
      if (typeof autoConfig.everyDays !== 'number' || autoConfig.everyDays < 1 || autoConfig.everyDays > 90) {
        return jsonResponse(400, { error: "everyDays must be between 1 and 90" }, originHdr, METHODS);
      }
      if (typeof autoConfig.minPrice !== 'number' || autoConfig.minPrice < 0) {
        return jsonResponse(400, { error: "minPrice must be >= 0" }, originHdr, METHODS);
      }
      
      // Ensure minPrice is less than current price
      if (autoConfig.minPrice >= existing.currentPrice) {
        return jsonResponse(400, { 
          error: `minPrice ($${autoConfig.minPrice.toFixed(2)}) must be less than current price ($${existing.currentPrice.toFixed(2)})` 
        }, originHdr, METHODS);
      }
    }

    // Update the binding
    const updated = await updateBinding(body.jobId, body.groupId, {
      auto: autoConfig,
    });

    if (!updated) {
      return jsonResponse(500, { error: "Failed to update binding" }, originHdr, METHODS);
    }

    console.log(`[price-reduction-update] User ${userId} updated binding ${body.jobId}/${body.groupId}:`, 
      autoConfig ? `$${autoConfig.reduceBy} every ${autoConfig.everyDays} days, floor $${autoConfig.minPrice}` : 'disabled');

    return jsonResponse(200, {
      success: true,
      binding: {
        jobId: updated.jobId,
        groupId: updated.groupId,
        auto: updated.auto,
        currentPrice: updated.currentPrice,
        updatedAt: updated.updatedAt,
      },
    }, originHdr, METHODS);
    
  } catch (err: any) {
    console.error("[price-reduction-update] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal error" }, originHdr, METHODS);
  }
};
