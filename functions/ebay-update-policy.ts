import type { Handler } from '@netlify/functions';
import { requireAuth, json } from './_auth.js';
import { getUserAccessToken, apiHost, headers } from './_ebay.js';

export const handler: Handler = async (event) => {
  try {
    const auth = await requireAuth(event);
    if (!auth) return json({ error: 'unauthorized' }, 401);
    const body = event.body ? JSON.parse(event.body) : {};
    const type = String(body.type || '').toLowerCase();
    const id = String(body.id || '').trim();
    if (!type || !id) return json({ error: 'missing type or id' }, 400);

    let token: string;
    try { token = await getUserAccessToken(auth.sub); } catch (e: any) {
      if (e?.code === 'ebay-not-connected') return json({ error: 'ebay-not-connected' }, 400);
      return json({ error: 'token-mint-failed', detail: e?.message || String(e) }, 500);
    }
    const host = apiHost();
    const h = headers(token);
    const mp = h['X-EBAY-C-MARKETPLACE-ID'] || 'EBAY_US';

    const map: Record<string, string> = {
      payment: 'payment_policy',
      fulfillment: 'fulfillment_policy',
      shipping: 'fulfillment_policy',
      return: 'return_policy',
      returns: 'return_policy',
    };
    const path = map[type];
    if (!path) return json({ error: 'invalid type' }, 400);
    const url = `${host}/sell/account/v1/${path}/${encodeURIComponent(id)}`;

    // Fetch current policy to merge safely
    const curRes = await fetch(url, { headers: h });
    const curTxt = await curRes.text(); let cur: any; try { cur = JSON.parse(curTxt); } catch { cur = {}; }
    if (!curRes.ok) return json({ error: 'get-policy failed', status: curRes.status, detail: cur }, curRes.status);

    let payload: any = {};
    if (path === 'payment_policy') {
      payload = {
        name: body.name ?? cur.name,
        marketplaceId: mp,
        categoryTypes: cur.categoryTypes || [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        immediatePay: body.immediatePay ?? cur.immediatePay ?? false,
      };
    } else if (path === 'fulfillment_policy') {
      const handlingDays = Number(body.handlingTimeDays ?? cur?.handlingTime?.value ?? 1);
      // preserve shippingOptions if not changing freeDomestic
      let shippingOptions = cur.shippingOptions || [];
      if (body.freeDomestic === true) {
        shippingOptions = [
          { optionType: 'DOMESTIC', costType: 'FLAT_RATE', shippingServices: [ { freeShipping: true, buyerResponsibleForShipping: false, shippingCarrierCode: 'USPS', shippingServiceCode: 'USPSPriorityFlatRateBox' } ] }
        ];
      }
      payload = {
        name: body.name ?? cur.name,
        marketplaceId: mp,
        categoryTypes: cur.categoryTypes || [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        handlingTime: { value: Math.max(0, handlingDays), unit: 'DAY' },
        shippingOptions,
      };
    } else if (path === 'return_policy') {
      const returnsAccepted = body.returnsAccepted ?? cur.returnsAccepted ?? true;
      const periodDays = Number(body.returnPeriodDays ?? cur?.returnPeriod?.value ?? 30);
      payload = returnsAccepted ? {
        name: body.name ?? cur.name,
        marketplaceId: mp,
        returnsAccepted: true,
        returnPeriod: { value: Math.max(1, periodDays), unit: 'DAY' },
        returnShippingCostPayer: (body.returnShippingCostPayer ?? cur.returnShippingCostPayer ?? 'BUYER'),
        refundMethod: body.refundMethod ?? cur.refundMethod ?? 'MONEY_BACK',
      } : {
        name: body.name ?? cur.name,
        marketplaceId: mp,
        returnsAccepted: false,
      };
    }

    const putRes = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify(payload) });
    const putTxt = await putRes.text(); let putBody: any; try { putBody = JSON.parse(putTxt); } catch { putBody = { raw: putTxt }; }
    if (!putRes.ok) return json({ error: 'update-policy failed', status: putRes.status, detail: putBody }, putRes.status);
    return json({ ok: true, policy: putBody });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
};
