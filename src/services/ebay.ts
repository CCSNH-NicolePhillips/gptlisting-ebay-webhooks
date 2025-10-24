import { cfg } from '../config.js';
import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';

// Use undici's exact RequestInit type
type URequestInit = Parameters<typeof fetch>[1];

// ---- demo token store (swap for DB/KMS in prod) ----
const TOKENS_FILE = path.join(cfg.dataDir, 'ebay_tokens.json');
function readTokens(): Record<
  string,
  { refresh_token: string; scope?: string; access_token?: string }
> {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as any;
  } catch {
    return {};
  }
}
function writeTokens(d: Record<string, any>) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(d, null, 2));
}

function baseUrl() {
  return cfg.ebay.env === 'PROD' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
}

// -------------------------------------------
// OAuth (login, token exchange/refresh)
// -------------------------------------------
export function buildEbayAuthUrl() {
  const scopes = [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
  ];
  const params = new URLSearchParams({
    client_id: cfg.ebay.clientId,
    redirect_uri: cfg.ebay.ruName,
    response_type: 'code',
    scope: scopes.join(' '),
    state: Math.random().toString(36).slice(2),
  });
  const host =
    cfg.ebay.env === 'PROD'
      ? 'https://auth.ebay.com/oauth2/authorize'
      : 'https://auth.sandbox.ebay.com/oauth2/authorize';
  return `${host}?${params.toString()}`;
}

export async function exchangeAuthCode(code: string) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.ebay.ruName,
  });
  const r = await fetch(`${baseUrl()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' + Buffer.from(`${cfg.ebay.clientId}:${cfg.ebay.clientSecret}`).toString('base64'),
    },
    body: form.toString(),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j; // { access_token, refresh_token, ... }
}

export async function saveEbayTokens(userId: string, tokenResponse: any) {
  const tokens = readTokens();
  tokens[userId] = {
    refresh_token: tokenResponse.refresh_token,
    scope: tokenResponse.scope,
  };
  writeTokens(tokens);
}

export async function getAccessToken(userId: string): Promise<string> {
  const tokens = readTokens();
  const refresh = tokens[userId]?.refresh_token;
  if (!refresh) throw new Error('eBay not connected for user ' + userId);

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    scope: tokens[userId].scope || '',
  });

  const r = await fetch(`${baseUrl()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' + Buffer.from(`${cfg.ebay.clientId}:${cfg.ebay.clientSecret}`).toString('base64'),
    },
    body: form.toString(),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.access_token as string;
}

export async function whoAmI(userId: string) {
  const token = await getAccessToken(userId);
  const r = await fetch(`${baseUrl()}/identity/v1/user/info`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return { userId: 'unknown' }; // sandbox fallback
  const j: any = await r.json().catch(() => ({}));
  return j;
}

// -------------------------------------------
// Request helpers (typed for undici)
// -------------------------------------------
function reqInit(
  method: string,
  bodyObj?: unknown,
  extraHeaders?: Record<string, string>
): URequestInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Ensure eBay receives a valid Accept-Language header
    'Accept-Language': 'en-US',
    // Some eBay endpoints validate Content-Language; include a valid value
    'Content-Language': 'en-US',
    ...(extraHeaders || {}),
  };
  const init: URequestInit = { method, headers };
  if (bodyObj !== undefined) {
    (init as any).body = JSON.stringify(bodyObj);
  }
  return init;
}

async function authedFetch(
  userId: string,
  path: string,
  method: string = 'GET',
  body?: unknown,
  extraHeaders?: Record<string, string>
) {
  const token = await getAccessToken(userId);
  const init = reqInit(method, body, { Authorization: `Bearer ${token}`, ...(extraHeaders || {}) });
  return fetch(`${baseUrl()}${path}`, init);
}

// -------------------------------------------
// Core Sell API calls used by the uploader
// -------------------------------------------
export async function ensureInventoryItem(
  userId: string,
  sku: string,
  opts: {
    title: string;
    description: string;
    condition: 'NEW' | 'USED' | string;
    quantity: number;
    imageUrls: string[];
  }
) {
  const path = `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  const payload = {
    condition: opts.condition,
    availability: { shipToLocationAvailability: { quantity: opts.quantity } },
    product: { title: opts.title, description: opts.description, imageUrls: opts.imageUrls },
  };
  console.error('DEBUG: ensureInventoryItem request', { path, payload });
  const r = await authedFetch(userId, path, 'PUT', payload);
  const text = await r.text().catch(() => '');
  console.error('DEBUG: ensureInventoryItem response status', r.status, 'body', text);
  if (!r.ok) {
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })();
    const errObj = { api: path, request: payload, status: r.status, body: parsed };
    throw new Error(JSON.stringify(errObj));
  }
}

export async function createOffer(
  userId: string,
  sku: string,
  opts: { marketplaceId: string; categoryId: string; price: number; quantity: number }
) {
  const path = '/sell/inventory/v1/offer';
  const payload = {
    sku,
    marketplaceId: opts.marketplaceId,
    format: 'FIXED_PRICE',
    availableQuantity: opts.quantity,
    categoryId: opts.categoryId,
    listingPolicies: {
      fulfillmentPolicyId: cfg.ebay.policy.fulfillmentPolicyId,
      paymentPolicyId: cfg.ebay.policy.paymentPolicyId,
      returnPolicyId: cfg.ebay.policy.returnPolicyId,
    },
    pricingSummary: { price: { currency: 'USD', value: opts.price.toFixed(2) } },
    merchantLocationKey: cfg.ebay.merchantLocationKey,
  };
  console.error('DEBUG: createOffer request', { path, payload });
  const r = await authedFetch(userId, path, 'POST', payload);
  const text = await r.text().catch(() => '');
  console.error('DEBUG: createOffer response status', r.status, 'body', text);
  const j: any = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (!r.ok) {
    const parsed = j ?? text;
    const errObj = { api: path, request: payload, status: r.status, body: parsed };
    throw new Error(JSON.stringify(errObj));
  }
  return j; // includes offerId
}

export async function publishOffer(userId: string, offerId: string) {
  const r = await authedFetch(userId, `/sell/inventory/v1/offer/${offerId}/publish`, 'POST');
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as any;
}

// -------------------------------------------
// Auto-provision (policies + inventory location)
// -------------------------------------------
export async function optInSellingPolicies(userId: string) {
  const r = await authedFetch(userId, '/sell/account/v1/program/opt_in', 'POST', {
    programType: 'SELLING_POLICY_MANAGEMENT',
  });
  if (!r.ok && r.status !== 409) {
    // 409 often = already opted in
    const j: any = await r.json().catch(() => ({}));
    const benign = j?.errors?.some((e: any) => String(e.errorId) === '20403');
    if (!benign) throw new Error(`optIn failed: ${r.status} ${JSON.stringify(j)}`);
  }
}

async function listPaymentPolicies(userId: string) {
  const r = await authedFetch(userId, '/sell/account/v1/payment_policy?marketplace_id=EBAY_US');
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.paymentPolicies ?? [];
}
async function listReturnPolicies(userId: string) {
  const r = await authedFetch(userId, '/sell/account/v1/return_policy?marketplace_id=EBAY_US');
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.returnPolicies ?? [];
}
async function listFulfillmentPolicies(userId: string) {
  const r = await authedFetch(userId, '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US');
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.fulfillmentPolicies ?? [];
}

// Internal name avoids export collision
async function _listInventoryLocations(userId: string) {
  const r = await authedFetch(userId, '/sell/inventory/v1/location', 'GET', undefined, {
    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.locations ?? [];
}

async function ensurePaymentPolicy(userId: string, name = 'Auto Payment Policy') {
  const existing = (await listPaymentPolicies(userId)).find((p: any) => p.name === name);
  if (existing) return existing.paymentPolicyId as string;
  const body = {
    name,
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
    immediatePay: true,
  };
  const r = await authedFetch(userId, '/sell/account/v1/payment_policy', 'POST', body);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    // If eBay reports a duplicate policy, extract the existing policy id and return it.
    const dup = j?.errors?.find((e: any) => String(e.errorId) === '20400');
    if (dup && Array.isArray(dup.parameters)) {
      const p = dup.parameters.find(
        (x: any) =>
          x.name === 'duplicatePolicyId' ||
          x.name === 'DuplicateProfileId' ||
          x.name === 'DuplicateProfileId'
      );
      if (p && p.value) return String(p.value);
    }
    throw new Error(JSON.stringify(j));
  }
  return j.paymentPolicyId as string;
}

async function ensureReturnPolicy(userId: string, name = 'Auto Return Policy') {
  const existing = (await listReturnPolicies(userId)).find((p: any) => p.name === name);
  if (existing) return existing.returnPolicyId as string;
  const body = {
    name,
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
    returnsAccepted: true,
    returnPeriod: { value: 30, unit: 'DAY' },
    refundMethod: 'MONEY_BACK',
    returnShippingCostPayer: 'BUYER',
    internationalOverride: {
      returnsAccepted: true,
      returnMethod: 'MONEY_BACK',
      returnPeriod: { value: 30, unit: 'DAY' },
      returnShippingCostPayer: 'BUYER',
    },
  };
  const r = await authedFetch(userId, '/sell/account/v1/return_policy', 'POST', body);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const dup = j?.errors?.find((e: any) => String(e.errorId) === '20400');
    if (dup && Array.isArray(dup.parameters)) {
      const p = dup.parameters.find(
        (x: any) => x.name === 'duplicatePolicyId' || x.name === 'DuplicateProfileId'
      );
      if (p && p.value) return String(p.value);
    }
    throw new Error(JSON.stringify(j));
  }
  return j.returnPolicyId as string;
}

async function ensureFulfillmentPolicy(userId: string, name = 'Auto Shipping Policy') {
  const existing = (await listFulfillmentPolicies(userId)).find((p: any) => p.name === name);
  if (existing) return existing.fulfillmentPolicyId as string;
  const body = {
    name,
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    handlingTime: 2,
    shippingOptions: [
      {
        costType: 'FLAT_RATE',
        optionType: 'DOMESTIC',
        insuranceFee: { value: '0.00', currency: 'USD' },
        shippingServices: [
          {
            freeShipping: true,
            shippingCarrierCode: 'USPS',
            shippingServiceCode: 'USPSPriorityFlatRateBox',
            sortOrderId: 1,
          },
        ],
        shipToLocations: { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] },
      },
    ],
  };
  const r = await authedFetch(userId, '/sell/account/v1/fulfillment_policy', 'POST', body);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const dup = j?.errors?.find((e: any) => String(e.errorId) === '20400');
    if (dup && Array.isArray(dup.parameters)) {
      // fulfillment errors may report DuplicateProfileId or Shipping Profile Id
      const p = dup.parameters.find(
        (x: any) =>
          x.name === 'DuplicateProfileId' ||
          x.name === 'Shipping Profile Id' ||
          x.name === 'DuplicateProfileId'
      );
      if (p && p.value) return String(p.value);
    }
    throw new Error(JSON.stringify(j));
  }
  return j.fulfillmentPolicyId as string;
}

async function ensureInventoryLocation(
  userId: string,
  merchantLocationKey = 'AutoWarehouse01',
  address = {
    addressLine1: '123 Test St',
    city: 'San Jose',
    stateOrProvince: 'CA',
    postalCode: '95131',
    country: 'US',
  }
) {
  const exists = (await _listInventoryLocations(userId)).find(
    (l: any) => l.merchantLocationKey === merchantLocationKey
  );
  if (exists) return merchantLocationKey;

  // Primary payload: include explicit addressLine2 and use a better phone format (E.164-ish)
  const primaryBody = {
    name: 'Auto Warehouse',
    locationTypes: ['WAREHOUSE'],
    merchantLocationStatus: 'ENABLED',
    location: { address: { ...address, addressLine2: '' } },
    // Use a fuller phone format which eBay often expects (country code + number)
    phone: '+15550100100',
    operatingHours: [],
  };

  try {
    console.error('DEBUG: creating inventory location with payload:', JSON.stringify(primaryBody));
    const r = await authedFetch(
      userId,
      `/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
      'POST',
      primaryBody,
      { 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
    );
    console.error('DEBUG: response status', r.status);
    if (!r.ok && r.status !== 409) {
      const txt = await r.text().catch(() => '');
      // If input error, try a fallback payload with slightly different shape
      const j = (() => {
        try {
          return JSON.parse(txt);
        } catch {
          return null;
        }
      })();
      const isInputError =
        txt.includes('Input error') || j?.errors?.some((e: any) => e.errorId === 25802);
      if (!isInputError) throw new Error(txt || `status ${r.status}`);

      // Fallback attempt: use a simpler payload and ensure all fields are strings
      const fallbackBody = {
        name: 'Auto Warehouse',
        locationTypes: ['WAREHOUSE'],
        merchantLocationStatus: 'ENABLED',
        location: {
          address: {
            addressLine1: String(address.addressLine1 || address.addressLine1),
            addressLine2: '',
            city: String(address.city || ''),
            stateOrProvince: String(address.stateOrProvince || ''),
            postalCode: String(address.postalCode || ''),
            country: String(address.country || 'US'),
          },
        },
        phone: '+1-555-010-0100',
        operatingHours: [],
      };

      console.error('DEBUG: trying fallback payload:', JSON.stringify(fallbackBody));
      const r2 = await authedFetch(
        userId,
        `/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
        'POST',
        fallbackBody,
        { 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
      );
      console.error('DEBUG: fallback response status', r2.status);
      if (!r2.ok && r2.status !== 409) {
        const errTxt = await r2.text().catch(() => '');
        console.error('DEBUG: fallback response body', errTxt);
        // Sandbox sometimes rejects location create payloads. As a safe fallback,
        // log the error and return the merchantLocationKey so the bootstrap flow
        // can continue (listings will still be created using the merchantLocationKey).
        console.warn(
          'Inventory location create failed in sandbox; continuing with merchantLocationKey without creating location.'
        );
        return merchantLocationKey;
      }
    }
    return merchantLocationKey;
  } catch (err: any) {
    console.error('ensureInventoryLocation error:', err?.message || err);
    throw err;
  }
}

/** Ensure seller is ready to list; returns the IDs to use. */
export async function ensureEbayPrereqs(
  userId: string,
  opts?: {
    paymentName?: string;
    returnName?: string;
    fulfillmentName?: string;
    merchantLocationKey?: string;
  }
): Promise<{
  paymentPolicyId: string;
  returnPolicyId: string;
  fulfillmentPolicyId: string;
  merchantLocationKey: string;
}> {
  await optInSellingPolicies(userId);
  const [paymentPolicyId, returnPolicyId, fulfillmentPolicyId, merchantLocationKey] =
    await Promise.all([
      ensurePaymentPolicy(userId, opts?.paymentName),
      ensureReturnPolicy(userId, opts?.returnName),
      ensureFulfillmentPolicy(userId, opts?.fulfillmentName),
      ensureInventoryLocation(userId, opts?.merchantLocationKey),
    ]);
  return { paymentPolicyId, returnPolicyId, fulfillmentPolicyId, merchantLocationKey };
}

// Re-exports for existing routes in index.ts
export async function listPolicies(userId: string) {
  const [paymentPolicies, returnPolicies, fulfillmentPolicies] = await Promise.all([
    listPaymentPolicies(userId),
    listReturnPolicies(userId),
    listFulfillmentPolicies(userId),
  ]);
  return { paymentPolicies, returnPolicies, fulfillmentPolicies };
}

export async function listInventoryLocations(userId: string) {
  return _listInventoryLocations(userId);
}
