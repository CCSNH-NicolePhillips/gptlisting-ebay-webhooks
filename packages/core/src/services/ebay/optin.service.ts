/**
 * packages/core/src/services/ebay/optin.service.ts
 *
 * Check whether the eBay seller account is opted into Business Policies.
 * Route: GET /api/ebay/optin
 */

import { getUserAccessToken, apiHost, headers } from '../../../../../src/lib/_ebay.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class OptinNotConnectedError extends Error {
  readonly statusCode = 400;
  constructor() { super('Connect eBay first'); this.name = 'OptinNotConnectedError'; }
}

export class OptinApiError extends Error {
  readonly statusCode: number;
  readonly detail?: unknown;
  constructor(msg: string, statusCode: number, detail?: unknown) {
    super(msg); this.name = 'OptinApiError'; this.statusCode = statusCode; this.detail = detail;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OptinResult {
  ok: true;
  optedIn: boolean;
  status?: string;
  detail?: {
    programType: string | undefined;
    optedIn: unknown;
    status: string | undefined;
  };
  programs?: Array<{ programType: string; optedIn: unknown; status: string | undefined }>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

function normalize(val: unknown) {
  return (val == null ? '' : String(val)).trim().toUpperCase();
}

const TRUTHY_STATUSES = ['OPTED_IN', 'ACTIVE', 'ENROLLED', 'ENABLED'];

function isProgramOptedIn(p: any): boolean {
  if (p?.optedIn === true) return true;
  const rawStr = normalize(p?.optedIn);
  if (['TRUE', 'YES', 'Y'].includes(rawStr) || TRUTHY_STATUSES.includes(rawStr)) return true;
  return TRUTHY_STATUSES.includes(normalize(p?.status));
}

function looksLikePolicies(p: any): boolean {
  const type = normalize(p?.programType);
  if (!type) return false;
  if (['SELLING_POLICY_MANAGEMENT', 'SELLING_POLICIES', 'BUSINESS_POLICIES', 'BUSINESS_POLICY_MANAGEMENT'].includes(type)) return true;
  return type.includes('POLICY');
}

/**
 * Check if the user's eBay account is opted into Business Policies.
 * @throws {OptinNotConnectedError} if eBay is not connected
 * @throws {OptinApiError}          if the eBay API call fails
 */
export async function checkOptin(userId: string): Promise<OptinResult> {
  let token: string;
  try {
    token = await getUserAccessToken(userId);
  } catch (e: any) {
    if (e?.code === 'ebay-not-connected') throw new OptinNotConnectedError();
    throw e;
  }

  const url = `${apiHost()}/sell/account/v1/program/get_opted_in_programs`;
  const res = await fetch(url, { headers: headers(token) });
  const txt = await res.text();
  let body: any;
  try { body = JSON.parse(txt); } catch { body = { raw: txt }; }
  if (!res.ok) throw new OptinApiError('check-optin-failed', res.status, body);

  const programs: any[] = Array.isArray(body?.programs) ? body.programs : [];
  const policyPrograms = programs.filter(looksLikePolicies);
  const optedIn = policyPrograms.some(isProgramOptedIn) || policyPrograms.length > 0;
  const representative = policyPrograms.find(isProgramOptedIn) || policyPrograms[0] || null;

  const result: OptinResult = { ok: true, optedIn };
  if (representative) {
    const status = normalize(representative?.status || representative?.optedIn || '');
    result.status = status && status !== '' ? status : (optedIn ? 'OPTED_IN' : undefined);
    result.detail = {
      programType: representative?.programType,
      optedIn: representative?.optedIn,
      status: representative?.status,
    };
  }
  const subset = policyPrograms.length ? policyPrograms : programs;
  if (subset.length) {
    result.programs = subset.slice(0, 5).map((p) => ({
      programType: p?.programType,
      optedIn: p?.optedIn,
      status: p?.status,
    }));
  }
  return result;
}
