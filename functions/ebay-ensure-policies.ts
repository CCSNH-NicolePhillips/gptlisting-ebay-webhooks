import type { Handler } from '@netlify/functions';
import { requireAuth, json } from './_auth.js';
import { getUserAccessToken, apiHost, headers } from './_ebay.js';

export const handler: Handler = async (event) => {
  try {
    const auth = await requireAuth(event);
    if (!auth) return json({ error: 'unauthorized' }, 401);
    let token: string;
    try { token = await getUserAccessToken(auth.sub); } catch (e: any) {
      if (e?.code === 'ebay-not-connected') return json({ error: 'ebay-not-connected' }, 400);
      return json({ error: 'token-mint-failed', detail: e?.message || String(e) }, 500);
    }
    const host = apiHost();
    const h = headers(token);
    const mp = h['X-EBAY-C-MARKETPLACE-ID'] || 'EBAY_US';

    async function getJson(url: string) {
      const r = await fetch(url, { headers: h });
      const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok, status: r.status, body: j };
    }
    async function postJson(url: string, body: any) {
      const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
      const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok, status: r.status, body: j };
    }

    // List existing
    const pay = await getJson(`${host}/sell/account/v1/payment_policy?marketplace_id=${mp}`);
    const ful = await getJson(`${host}/sell/account/v1/fulfillment_policy?marketplace_id=${mp}`);
    const ret = await getJson(`${host}/sell/account/v1/return_policy?marketplace_id=${mp}`);

    const paymentPolicies = Array.isArray(pay.body?.paymentPolicies) ? pay.body.paymentPolicies : [];
    const fulfillmentPolicies = Array.isArray(ful.body?.fulfillmentPolicies) ? ful.body.fulfillmentPolicies : [];
    const returnPolicies = Array.isArray(ret.body?.returnPolicies) ? ret.body.returnPolicies : [];

    const result: { paymentPolicyId?: string; fulfillmentPolicyId?: string; returnPolicyId?: string } = {};

    // Payment: prefer a named one, else create
    let payPick = paymentPolicies[0];
    const payDefaultName = 'Default Payment (Auto)';
    const namedPay = paymentPolicies.find((p: any) => (p?.name || '') === payDefaultName);
    if (namedPay) payPick = namedPay;
    if (!payPick) {
      const payload = {
        name: payDefaultName,
        marketplaceId: mp,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        immediatePay: true,
      };
      const created = await postJson(`${host}/sell/account/v1/payment_policy`, payload);
      if (!created.ok) return json({ ok: false, error: 'payment-create-failed', detail: created.body }, created.status);
      payPick = created.body;
    }
    result.paymentPolicyId = String(payPick?.id || payPick?.paymentPolicyId || payPick?.policyId || '');

    // Fulfillment
    let fulPick = fulfillmentPolicies[0];
    const fulDefaultName = 'Default Shipping (Auto)';
    const namedFul = fulfillmentPolicies.find((p: any) => (p?.name || '') === fulDefaultName);
    if (namedFul) fulPick = namedFul;
    if (!fulPick) {
      const payload = {
        name: fulDefaultName,
        marketplaceId: mp,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
  handlingTime: { value: 1, unit: 'DAY' },
        shippingOptions: [
          {
            optionType: 'DOMESTIC',
            costType: 'FLAT_RATE',
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
      const created = await postJson(`${host}/sell/account/v1/fulfillment_policy`, payload);
      if (!created.ok) return json({ ok: false, error: 'fulfillment-create-failed', detail: created.body }, created.status);
      fulPick = created.body;
    }
    result.fulfillmentPolicyId = String(fulPick?.id || fulPick?.fulfillmentPolicyId || fulPick?.policyId || '');

    // Return
    let retPick = returnPolicies[0];
    const retDefaultName = 'Default Returns (Auto)';
    const namedRet = returnPolicies.find((p: any) => (p?.name || '') === retDefaultName);
    if (namedRet) retPick = namedRet;
    if (!retPick) {
      const payload = {
        name: retDefaultName,
        marketplaceId: mp,
        returnsAccepted: true,
        returnPeriod: { value: 30, unit: 'DAY' },
        returnShippingCostPayer: 'BUYER',
        refundMethod: 'MONEY_BACK',
      };
      const created = await postJson(`${host}/sell/account/v1/return_policy`, payload);
      if (!created.ok) return json({ ok: false, error: 'return-create-failed', detail: created.body }, created.status);
      retPick = created.body;
    }
    result.returnPolicyId = String(retPick?.id || retPick?.returnPolicyId || retPick?.policyId || '');

    return json({ ok: true, ...result });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
};
