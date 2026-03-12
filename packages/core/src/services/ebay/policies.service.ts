/**
 * packages/core/src/services/ebay/policies.service.ts
 *
 * eBay Business Policy CRUD + per-user defaults:
 *   listPolicies(userId)        → GET  /api/ebay/policies
 *   getPolicy(userId,type,id)   → GET  /api/ebay/policies/:id?type=
 *   createPolicy(userId,body)   → POST /api/ebay/policies
 *   deletePolicy(userId,type,id)→ DELETE /api/ebay/policies/:id
 *   getPolicyDefaults(userId)   → GET  /api/ebay/policies/defaults
 *   setPolicyDefault(...)       → POST /api/ebay/policies/defaults
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';
import { getUserAccessToken, apiHost, headers as ebayHeaders } from '../../../../../src/lib/_ebay.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class PolicyNotConnectedError extends Error {
  readonly statusCode = 400;
  constructor() { super('Connect eBay first'); this.name = 'PolicyNotConnectedError'; }
}

export class PolicyApiError extends Error {
  readonly statusCode: number;
  readonly detail?: unknown;
  constructor(msg: string, statusCode: number, detail?: unknown) {
    super(msg); this.name = 'PolicyApiError'; this.statusCode = statusCode; this.detail = detail;
  }
}

export class PolicyValidationError extends Error {
  readonly statusCode = 400;
  constructor(msg: string) { super(msg); this.name = 'PolicyValidationError'; }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  payment: 'payment_policy',
  fulfillment: 'fulfillment_policy',
  shipping: 'fulfillment_policy',
  return: 'return_policy',
  returns: 'return_policy',
};

function resolvePathType(type: string): string {
  const pt = TYPE_MAP[type.toLowerCase()];
  if (!pt) throw new PolicyValidationError(`Invalid policy type: "${type}". Use payment, fulfillment, or return`);
  return pt;
}

async function getAccessToken(userId: string): Promise<string> {
  try {
    return await getUserAccessToken(userId, [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.account',
    ]);
  } catch (e: any) {
    if (e?.code === 'ebay-not-connected') throw new PolicyNotConnectedError();
    throw e;
  }
}

async function fetchEbay(url: string, token: string, options?: RequestInit) {
  const h = ebayHeaders(token);
  const res = await fetch(url, { ...options, headers: { ...h, ...(options?.headers as any || {}) } });
  const txt = await res.text();
  let json: any;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { ok: res.ok, status: res.status, json };
}

// ─── Helpers: normalize money / sanitize fulfillment ─────────────────────────

function normalizeMoney(input: any, fallbackCurrency = 'USD', fallbackValue = '0.00') {
  if (!input || typeof input !== 'object') return { value: fallbackValue, currency: fallbackCurrency };
  const currency = input.currency || fallbackCurrency;
  const num = Number(input.value);
  return { value: Number.isFinite(num) ? num.toFixed(2) : fallbackValue, currency };
}

function sanitizeFulfillmentPayload(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;
  payload.globalShipping = !!payload.globalShipping;
  payload.pickupDropOff = !!payload.pickupDropOff;
  payload.freightShipping = !!payload.freightShipping;
  if (!payload.shipToLocations) {
    payload.shipToLocations = { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] };
  }
  if (!Array.isArray(payload.shippingOptions)) return payload;
  payload.shippingOptions = payload.shippingOptions.map((option: any, _optIdx: number) => {
    if (!option || typeof option !== 'object') return option;
    const n = { ...option };
    delete n.insuranceFee;
    if (!n.shipToLocations) n.shipToLocations = { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] };
    n.packageHandlingCost = normalizeMoney(n.packageHandlingCost);
    n.shippingDiscountProfileId = n.shippingDiscountProfileId != null ? String(n.shippingDiscountProfileId) : '0';
    n.shippingPromotionOffered = !!n.shippingPromotionOffered;
    if (Array.isArray(n.shippingServices)) {
      n.shippingServices = n.shippingServices.map((svc: any, svcIdx: number) => {
        if (!svc || typeof svc !== 'object') return svc;
        const service = { ...svc };
        if (service.sortOrder == null) {
          const parsed = Number(service.sortOrderId);
          service.sortOrder = Number.isFinite(parsed) ? parsed : svcIdx + 1;
        }
        delete service.sortOrderId;
        if (service.shippingCost?.value != null && typeof service.shippingCost.value === 'number') {
          service.shippingCost = { ...service.shippingCost, value: service.shippingCost.value.toFixed(2) };
        }
        if (service.additionalShippingCost?.value != null && typeof service.additionalShippingCost.value === 'number') {
          service.additionalShippingCost = { ...service.additionalShippingCost, value: service.additionalShippingCost.value.toFixed(2) };
        }
        service.buyerResponsibleForShipping = !!service.buyerResponsibleForShipping;
        service.buyerResponsibleForPickup = !!service.buyerResponsibleForPickup;
        return service;
      });
    }
    if (!Array.isArray(n.shippingServices)) n.shippingServices = [];
    if (n.calculatedShippingRate) {
      const calc = { ...n.calculatedShippingRate };
      const fixDim = (dim: any) => (!dim || typeof dim !== 'object' ? dim
        : typeof dim.value === 'string' ? dim : { ...dim, value: dim.value != null ? String(dim.value) : dim.value });
      calc.packageLength = fixDim(calc.packageLength);
      calc.packageWidth = fixDim(calc.packageWidth);
      calc.packageHeight = fixDim(calc.packageHeight);
      calc.weightMajor = fixDim(calc.weightMajor);
      calc.weightMinor = fixDim(calc.weightMinor);
      calc.measurementSystem = (calc.measurementSystem || 'ENGLISH').toString().toUpperCase();
      n.calculatedShippingRate = calc;
    }
    return n;
  });
  return payload;
}

// ─── Services ─────────────────────────────────────────────────────────────────

/** List all three eBay policy types. */
export async function listPolicies(userId: string) {
  const token = await getAccessToken(userId);
  const host = apiHost();
  const h = ebayHeaders(token);
  const mp = h['X-EBAY-C-MARKETPLACE-ID'] || 'EBAY_US';

  const [fulfillment, payment, returns] = await Promise.all([
    fetchEbay(`${host}/sell/account/v1/fulfillment_policy?marketplace_id=${mp}`, token),
    fetchEbay(`${host}/sell/account/v1/payment_policy?marketplace_id=${mp}`, token),
    fetchEbay(`${host}/sell/account/v1/return_policy?marketplace_id=${mp}`, token),
  ]);

  const hasNotEligible = [fulfillment, payment, returns].some((r) => {
    const errs = (r?.json as any)?.errors as any[] | undefined;
    return Array.isArray(errs) && errs.some((e) => e?.errorId === 20403);
  });

  return {
    fulfillment,
    payment,
    returns,
    eligibility: hasNotEligible
      ? {
          businessPoliciesEligible: false,
          hint: 'This eBay account is not opted into Business Policies.',
          marketplaceId: mp,
        }
      : { businessPoliciesEligible: true, marketplaceId: mp },
  };
}

/** Get a specific eBay policy by type and ID. */
export async function getPolicy(userId: string, type: string, id: string) {
  const pathType = resolvePathType(type);
  const token = await getAccessToken(userId);
  const host = apiHost();
  const res = await fetchEbay(`${host}/sell/account/v1/${pathType}/${encodeURIComponent(id)}`, token);
  if (!res.ok) throw new PolicyApiError(`get-policy failed`, res.status, res.json);
  return { ok: true, policy: res.json };
}

/** Build the eBay policy payload from user-supplied body. */
function buildPolicyPayload(pathType: string, body: any, mp: string): any {
  if (pathType === 'payment_policy') {
    return {
      name: body.name || 'Payment Policy',
      marketplaceId: mp,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      immediatePay: !!body.immediatePay,
    };
  }

  if (pathType === 'return_policy') {
    const returnsAccepted = body.returnsAccepted !== false;
    const periodDays = Number(body.returnPeriodDays ?? 30);
    return returnsAccepted ? {
      name: body.name || 'Returns Policy',
      marketplaceId: mp,
      returnsAccepted: true,
      returnPeriod: { value: Math.max(1, isNaN(periodDays) ? 30 : periodDays), unit: 'DAY' },
      returnShippingCostPayer: body.returnShippingCostPayer || 'BUYER',
      refundMethod: body.refundMethod || 'MONEY_BACK',
    } : {
      name: body.name || 'No Returns Policy',
      marketplaceId: mp,
      returnsAccepted: false,
    };
  }

  // fulfillment_policy
  const handlingDays = Number(body.handlingTimeDays ?? 1);
  const freeDomestic = !!body.freeDomestic;
  const costType = body.costType === 'FLAT_RATE' ? 'FLAT_RATE' : 'CALCULATED';
  const domesticShipTo = { shipToLocations: { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] } };

  let shippingOptions: any[] | undefined;
  const costNum = Number(body.shippingCostValue);
  const addlCostNum = Number(body.additionalShippingCostValue);
  const hasCost = Number.isFinite(costNum);
  const hasAddl = Number.isFinite(addlCostNum);

  if (freeDomestic) {
    shippingOptions = [{
      optionType: 'DOMESTIC',
      costType: 'FLAT_RATE',
      shippingServices: [{
        freeShipping: true, shippingCarrierCode: 'USPS', shippingServiceCode: 'USPSPriorityFlatRateBox',
        sortOrder: 1, buyerResponsibleForShipping: false, buyerResponsibleForPickup: false,
      }],
      packageHandlingCost: { value: '0.00', currency: 'USD' },
      shippingDiscountProfileId: '0', shippingPromotionOffered: false, ...domesticShipTo,
    }];
  } else if (body.shippingServiceCode) {
    let calcRate: any = null;
    if (costType === 'CALCULATED') {
      const ms = (body.calcMeasurementSystem === 'METRIC') ? 'METRIC' : 'ENGLISH';
      const toN = (v: any, def: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; };
      const dimUnit = ms === 'METRIC' ? 'CENTIMETER' : 'INCH';
      const majUnit = ms === 'METRIC' ? 'KILOGRAM' : 'POUND';
      const minUnit = ms === 'METRIC' ? 'GRAM' : 'OUNCE';
      calcRate = {
        measurementSystem: ms,
        packageType: body.calcPackageType || 'PACKAGE_THICK_ENVELOPE',
        packageLength: { value: String(toN(body.calcLength, ms === 'METRIC' ? 30 : 12)), unit: dimUnit },
        packageWidth:  { value: String(toN(body.calcWidth,  ms === 'METRIC' ? 20 : 9)),  unit: dimUnit },
        packageHeight: { value: String(toN(body.calcHeight, ms === 'METRIC' ? 8 : 3)),   unit: dimUnit },
        weightMajor:   { value: String(toN(body.calcWeightMajor, 1)), unit: majUnit },
        weightMinor:   { value: String(toN(body.calcWeightMinor, 0)), unit: minUnit },
      };
    }
    shippingOptions = [{
      optionType: 'DOMESTIC', costType,
      shippingServices: [{
        freeShipping: false,
        shippingCarrierCode: body.shippingCarrierCode || 'USPS',
        shippingServiceCode: body.shippingServiceCode,
        sortOrder: 1,
        buyerResponsibleForShipping: false, buyerResponsibleForPickup: false,
        ...(costType === 'FLAT_RATE' ? {
          shippingCost: { value: (hasCost ? costNum : 0).toFixed(2), currency: 'USD' },
          ...(hasAddl ? { additionalShippingCost: { value: addlCostNum.toFixed(2), currency: 'USD' } } : {}),
        } : {}),
      }],
      ...(calcRate ? { calculatedShippingRate: calcRate } : {}),
      packageHandlingCost: { value: '0.00', currency: 'USD' },
      shippingDiscountProfileId: '0', shippingPromotionOffered: false, ...domesticShipTo,
    }];
  }

  const raw = {
    name: body.name || 'Shipping Policy',
    marketplaceId: mp,
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    handlingTime: { value: Math.max(0, isNaN(handlingDays) ? 1 : handlingDays), unit: 'DAY' },
    ...(shippingOptions ? { shippingOptions } : {}),
    ...domesticShipTo,
    globalShipping: false, pickupDropOff: false, freightShipping: false,
  };
  return sanitizeFulfillmentPayload(raw);
}

/** Create an eBay policy. */
export async function createPolicy(userId: string, body: any) {
  const type = String(body.type || '').toLowerCase();
  if (!type) throw new PolicyValidationError('Missing type field');
  const pathType = resolvePathType(type);

  const token = await getAccessToken(userId);
  const host = apiHost();
  const h = ebayHeaders(token);
  const mp = h['X-EBAY-C-MARKETPLACE-ID'] || 'EBAY_US';

  const payload = buildPolicyPayload(pathType, body, mp);

  const res = await fetchEbay(`${host}/sell/account/v1/${pathType}`, token, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' } as any,
  });
  if (!res.ok) throw new PolicyApiError('create-policy failed', res.status, { detail: res.json, sent: payload });

  const id = String(
    res.json?.id || res.json?.policyId || res.json?.paymentPolicyId ||
    res.json?.fulfillmentPolicyId || res.json?.returnPolicyId || ''
  ).trim();

  // Optionally set as default
  let defaultsUpdated: any = null;
  if (id && body.setDefault) {
    try {
      const store = tokensStore();
      const key = userScopedKey(userId, 'policy-defaults.json');
      const cur = ((await store.get(key, { type: 'json' })) as any) || {};
      if (pathType === 'payment_policy') cur.payment = id;
      else if (pathType === 'fulfillment_policy') cur.fulfillment = id;
      else if (pathType === 'return_policy') cur.return = id;
      await store.set(key, JSON.stringify(cur));
      defaultsUpdated = cur;
    } catch {}
  }

  return { ok: true, id, policy: res.json, defaults: defaultsUpdated };
}

/** Delete an eBay policy. */
export async function deletePolicy(userId: string, type: string, id: string) {
  const pathType = resolvePathType(type);
  const token = await getAccessToken(userId);
  const host = apiHost();

  const res = await fetchEbay(`${host}/sell/account/v1/${pathType}/${encodeURIComponent(id)}`, token, {
    method: 'DELETE',
  });
  if (!res.ok) throw new PolicyApiError('delete-policy failed', res.status, res.json);

  return { ok: true, deleted: { type: pathType, id } };
}

/** Get per-user saved policy defaults from Redis. */
export async function getPolicyDefaults(userId: string) {
  const store = tokensStore();
  let prefs: any = {};
  try {
    prefs = (await store.get(userScopedKey(userId, 'policy-defaults.json'), { type: 'json' })) as any;
  } catch {}
  if (!prefs || typeof prefs !== 'object') prefs = {};
  return { ok: true, defaults: prefs };
}

/** Set a policy default (payment | fulfillment | fulfillmentFree | return). */
export async function setPolicyDefault(userId: string, type: string, policyId: string) {
  const store = tokensStore();
  const key = userScopedKey(userId, 'policy-defaults.json');
  const cur = ((await store.get(key, { type: 'json' })) as any) || {};

  // fulfillmentFree is a custom DraftPilot concept (free-shipping policy for items < $50).
  // It does not correspond to an eBay API policy type, so we bypass normal path resolution.
  if (type === 'fulfillmentFree') {
    if (policyId) cur.fulfillmentFree = policyId;
    else delete cur.fulfillmentFree;
    await store.set(key, JSON.stringify(cur));
    return { ok: true, defaults: cur };
  }

  const pathType = resolvePathType(type);
  if (pathType === 'payment_policy') cur.payment = policyId;
  else if (pathType === 'fulfillment_policy') cur.fulfillment = policyId;
  else if (pathType === 'return_policy') cur.return = policyId;
  await store.set(key, JSON.stringify(cur));
  return { ok: true, defaults: cur };
}
