import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { clearUserJobs } from "../../src/lib/job-store.js";
import { requireUserAuth } from "../../src/lib/auth-user.js";

/**
 * POST /.netlify/functions/smartdrafts-reset?folder=<url>
 * 
 * Clears Redis cache/job entries for the authenticated user
 * Returns { ok: true, cleared: number }
 * 
 * Note: 'folder' parameter is accepted but currently all user jobs are cleared
 * (could be enhanced to clear only jobs matching specific folder path)
 */

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);
  const methods = "POST, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, methods);
  }

  // Get authenticated user
  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch (err: any) {
    return jsonResponse(401, { error: "Unauthorized", message: err.message }, originHdr, methods);
  }

  const folder = event.queryStringParameters?.folder || "";

  if (!folder) {
    return jsonResponse(400, { error: "folder parameter required" }, originHdr, methods);
  }

  try {
    // Clear all Redis keys for this user
    // This includes: job:userId:*, price:userId:*, taxo:ovr:userId:*, jobsidx:userId
    const cleared = await clearUserJobs(user.userId);
    
    console.log(`[smartdrafts-reset] Cleared ${cleared} Redis keys for user ${user.userId}`);
    
    return jsonResponse(200, {
      ok: true,
      cleared,
      message: `Cleared ${cleared} cache entries for user`
    }, originHdr, methods);
  } catch (error: any) {
    console.error("[smartdrafts-reset] error:", error);
    return jsonResponse(500, {
      error: "Reset failed",
      message: error?.message || String(error)
    }, originHdr, methods);
  }
};
