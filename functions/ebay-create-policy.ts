import type { Handler } from '@netlify/functions';
import { json, userScopedKey, getBearerToken, getJwtSubUnverified, requireAuthVerified } from './_auth.js';
import { getUserAccessToken, apiHost, headers } from './_ebay.js';
import { tokensStore } from './_blobs.js';

export const handler: Handler = async (event) => {
  try {
    // Verify auth (allow Auth0-verified or Netlify Identity tokens)
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return json({ error: 'unauthorized' }, 401);

    const body = event.body ? JSON.parse(event.body) : {};
    const type = String(body.type || '').toLowerCase();
    if (!type) return json({ error: 'missing type' }, 400);

    // Mint eBay access token
    let token: string;
    try {
      token = await getUserAccessToken(sub, [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.account',
      ]);
    } catch (e: any) {
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

    // Build payload
    let payload: any = {};
    if (path === 'payment_policy') {
      payload = {
        name: body.name || 'Payment Policy',
        marketplaceId: mp,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        immediatePay: !!body.immediatePay,
      };
    } else if (path === 'fulfillment_policy') {
      const handlingDays = Number(body.handlingTimeDays ?? 1);
      const freeDomestic = !!body.freeDomestic;
      const costType = (body.costType === 'FLAT_RATE') ? 'FLAT_RATE' : 'CALCULATED';
      let shippingOptions: any[] | undefined;
      if (freeDomestic) {
        shippingOptions = [
          {
            optionType: 'DOMESTIC',
            costType: 'FLAT_RATE',
            shippingServices: [
              {
                freeShipping: true,
                shippingCarrierCode: 'USPS',
                shippingServiceCode: 'USPSGroundAdvantage',
                sortOrder: 1,
              },
            ],
          },
        ];
      } else if (body.shippingServiceCode) {
        shippingOptions = [
          {
            optionType: 'DOMESTIC',
            costType,
            shippingServices: [
              {
                freeShipping: false,
                shippingCarrierCode: body.shippingCarrierCode || 'USPS',
                shippingServiceCode: body.shippingServiceCode,
                sortOrder: 1,
                ...(costType === 'FLAT_RATE'
                  ? { shippingCost: { value: String(body.shippingCostValue || '0.00'), currency: 'USD' },
                      ...(body.additionalShippingCostValue ? { additionalShippingCost: { value: String(body.additionalShippingCostValue), currency: 'USD' } } : {})
                    }
                  : {}),
              },
            ],
          },
        ];
      }
      payload = {
        name: body.name || 'Shipping Policy',
        marketplaceId: mp,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        handlingTime: { value: Math.max(0, isNaN(handlingDays) ? 1 : handlingDays), unit: 'DAY' },
        ...(shippingOptions ? { shippingOptions } : {}),
      };
    } else if (path === 'return_policy') {
      const returnsAccepted = body.returnsAccepted !== false;
      const periodDays = Number(body.returnPeriodDays ?? 30);
      payload = returnsAccepted ? {
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

    // Create policy
    const res = await fetch(`${host}/sell/account/v1/${path}`, { method: 'POST', headers: h as any, body: JSON.stringify(payload) });
    const txt = await res.text(); let j: any; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
    if (!res.ok) {
      const www = res.headers.get('www-authenticate') || '';
      return json({ error: 'create-policy failed', status: res.status, auth: www, detail: j, sent: payload }, res.status);
    }

    // Extract ID returned by eBay
    const id = String(j?.id || j?.policyId || j?.paymentPolicyId || j?.fulfillmentPolicyId || j?.returnPolicyId || '').trim();

    // Optionally set as default
    let defaultsUpdated: any = null;
    if (id && body.setDefault) {
      try {
        const store = tokensStore();
        const key = userScopedKey(sub, 'policy-defaults.json');
        const cur = ((await store.get(key, { type: 'json' })) as any) || {};
        if (path === 'payment_policy') cur.payment = id;
        else if (path === 'fulfillment_policy') cur.fulfillment = id;
        else if (path === 'return_policy') cur.return = id;
        await store.set(key, JSON.stringify(cur));
        defaultsUpdated = cur;
      } catch {}
    }

    return json({ ok: true, id, policy: j, defaults: defaultsUpdated });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
};
