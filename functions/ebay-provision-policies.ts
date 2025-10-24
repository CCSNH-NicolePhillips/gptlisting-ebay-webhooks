import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from './_auth.js';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';

type JsonRes = { status: number; json: any };

export const handler: Handler = async (event) => {
  try {
    const store = tokensStore();
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub)
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh)
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Connect eBay first' }),
      };

    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

    const headers = {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    } as Record<string, string>;

    async function getJson(path: string): Promise<JsonRes> {
      const res = await fetch(`${apiHost}${path}`, { headers });
      const txt = await res.text();
      try {
        return { status: res.status, json: JSON.parse(txt) };
      } catch {
        return { status: res.status, json: { raw: txt } };
      }
    }

    async function postJson(path: string, body: any): Promise<JsonRes> {
      const res = await fetch(`${apiHost}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const txt = await res.text();
      try {
        return { status: res.status, json: JSON.parse(txt) };
      } catch {
        return { status: res.status, json: { raw: txt } };
      }
    }

    // Check eligibility via listing endpoints (will return 20403 if not eligible)
    const [fulfillmentList, paymentList, returnList] = await Promise.all([
      getJson(`/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`),
      getJson(`/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`),
      getJson(`/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}`),
    ]);

    const hasNotEligible = [fulfillmentList, paymentList, returnList].some(
      (r) => Array.isArray(r?.json?.errors) && r.json.errors.some((e: any) => e?.errorId === 20403)
    );
    if (hasNotEligible) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'not-eligible',
          message: 'This account is not opted into Business Policies.',
          hint: 'Opt in at https://www.ebay.com/sh/str/selling-policies (Account settings > Selling > Business policies), then retry.',
          marketplaceId: MARKETPLACE_ID,
          diagnostics: { fulfillmentList, paymentList, returnList },
        }),
      };
    }

    // If lists returned successfully, extract existing names
    const existing = {
      fulfillment: (fulfillmentList.json?.fulfillmentPolicies || []) as any[],
      payment: (paymentList.json?.paymentPolicies || []) as any[],
      returns: (returnList.json?.returnPolicies || []) as any[],
    };

      const results: Record<string, any> = { marketplaceId: MARKETPLACE_ID };
      const chosen: { fulfillment?: string; payment?: string; return?: string } = {};

    // Create Payment Policy if none by our default name
    const defaultPaymentName = 'Default Payment (Auto)';
    const hasPayment = existing.payment.some((p) => p.name === defaultPaymentName);
    if (!hasPayment) {
      const payload = {
        name: defaultPaymentName,
        marketplaceId: MARKETPLACE_ID,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        // immediatePay can be toggled later via UI if desired
        immediatePay: false,
      };
      const resp = await postJson('/sell/account/v1/payment_policy', payload);
      results.payment = resp;
      try {
        const id = String(
          resp?.json?.id || resp?.json?.paymentPolicyId || resp?.json?.policyId || ''
        ).trim();
        if (id) chosen.payment = id;
      } catch {}
    } else {
      results.payment = { status: 'exists' };
      try {
        const found = existing.payment.find((p) => p.name === defaultPaymentName);
        const id = String(
          found?.id || found?.paymentPolicyId || found?.policyId || ''
        ).trim();
        if (id) chosen.payment = id;
      } catch {}
    }

    // Create Return Policy if none by our preferred name
    const qs = event?.queryStringParameters || ({} as Record<string, string>);
    const envReturns = (process.env.EBAY_RETURNS_ACCEPTED || '').toLowerCase();
    const qsReturns = (qs['returnsAccepted'] || qs['returns'] || '').toLowerCase();
    const wantsNoReturns =
      qsReturns === 'false' ||
      qsReturns === 'none' ||
      envReturns === 'false' ||
      envReturns === 'none';
    const returnPolicyName = wantsNoReturns ? 'No Returns (Auto)' : 'Default Returns (Auto)';
    const hasReturn = existing.returns.some((p) => p.name === returnPolicyName);
    if (!hasReturn) {
      const payload = wantsNoReturns
        ? {
            name: returnPolicyName,
            marketplaceId: MARKETPLACE_ID,
            returnsAccepted: false,
          }
        : {
            name: returnPolicyName,
            marketplaceId: MARKETPLACE_ID,
            returnsAccepted: true,
            returnPeriod: { value: 30, unit: 'DAY' },
            returnShippingCostPayer: 'BUYER',
            refundMethod: 'MONEY_BACK',
          };
      const resp = await postJson('/sell/account/v1/return_policy', payload);
      results.returns = resp;
      try {
        const id = String(
          resp?.json?.id || resp?.json?.returnPolicyId || resp?.json?.policyId || ''
        ).trim();
        if (id) chosen.return = id;
      } catch {}
    } else {
      results.returns = { status: 'exists', name: returnPolicyName };
      try {
        const found = existing.returns.find((p) => p.name === returnPolicyName);
        const id = String(
          found?.id || found?.returnPolicyId || found?.policyId || ''
        ).trim();
        if (id) chosen.return = id;
      } catch {}
    }

    // Create Fulfillment Policy if none by our default name
    const defaultShipName = 'Default Shipping (Auto)';
    const hasFulfillment = existing.fulfillment.some((p) => p.name === defaultShipName);
    if (!hasFulfillment) {
      const payload = {
        name: defaultShipName,
        marketplaceId: MARKETPLACE_ID,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
  handlingTime: { value: 1, unit: 'DAY' },
        shippingOptions: [
          {
            optionType: 'DOMESTIC',
            costType: 'FLAT_RATE',
            insuranceFee: { value: '0.00', currency: 'USD' },
      shippingServices: [
        {
          // Free domestic USPS Priority Flat Rate Box (doc sample, widely accepted)
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
      const resp = await postJson('/sell/account/v1/fulfillment_policy', payload);
      results.fulfillment = resp;
      try {
        const id = String(
          resp?.json?.id || resp?.json?.fulfillmentPolicyId || resp?.json?.policyId || ''
        ).trim();
        if (id) chosen.fulfillment = id;
      } catch {}
    } else {
      results.fulfillment = { status: 'exists' };
      try {
        const found = existing.fulfillment.find((p) => p.name === defaultShipName);
        const id = String(
          found?.id || found?.fulfillmentPolicyId || found?.policyId || ''
        ).trim();
        if (id) chosen.fulfillment = id;
      } catch {}
    }

    // Persist selected policy IDs as this user's defaults so draft creation uses all three
    try {
      const key = userScopedKey(sub, 'policy-defaults.json');
      const cur = ((await store.get(key, { type: 'json' })) as any) || {};
      const merged = { ...cur, ...chosen };
      // Remove empty values
      Object.keys(merged).forEach((k) => {
        if (!merged[k]) delete merged[k];
      });
      if (Object.keys(merged).length) await store.set(key, JSON.stringify(merged));
      results.defaults = { saved: true, values: merged };
    } catch {
      // ignore
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, results }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e?.message || String(e) }),
    };
  }
};
