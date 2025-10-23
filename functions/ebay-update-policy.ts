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

    // Helper: ensure categoryTypes includes a default entry
    const normalizeCategoryTypes = (ct: any): any[] => {
      let arr: any[] = Array.isArray(ct) && ct.length ? ct : [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];
      // Ensure exactly one default: true
      let hasDefault = arr.some((x) => x && x.default === true);
      if (!hasDefault) arr = arr.map((x, i) => ({ ...x, default: i === 0 }));
      return arr;
    };

    const stripReadOnly = (obj: any, keys: string[]) => {
      for (const k of keys) delete obj[k];
      return obj;
    };

    const ensureFulfillmentShippingOptions = (
      curOptions: any,
      forceFreeDomestic: boolean,
      carrier?: string,
      serviceCode?: string
    ) => {
      if (forceFreeDomestic) {
        return [
          {
            optionType: 'DOMESTIC',
            costType: 'FLAT_RATE',
            insuranceFee: { value: '0.00', currency: 'USD' },
            shippingServices: [
              {
                shippingServiceCode: 'USPSFirstClass',
                sortOrderId: 1,
                freeShipping: true,
                shippingCarrierCode: 'USPS',
              },
            ],
          },
        ];
      }
      // If a specific paid service is chosen, honor it
      if (serviceCode) {
        const shipCarrier = carrier || 'USPS';
        return [
          {
            optionType: 'DOMESTIC',
            costType: 'FLAT_RATE',
            insuranceFee: { value: '0.00', currency: 'USD' },
            shippingServices: [
              {
                shippingServiceCode: serviceCode,
                sortOrderId: 1,
                freeShipping: false,
                buyerResponsibleForShipping: true,
                shippingCarrierCode: shipCarrier,
              },
            ],
          },
        ];
      }
      // If we have existing, keep them; else, synthesize a minimal free domestic option
      if (Array.isArray(curOptions) && curOptions.length) return curOptions;
      // Default to a paid USPS Priority if user unchecked free but didn't choose a service
      return [
        {
          optionType: 'DOMESTIC',
          costType: 'FLAT_RATE',
          insuranceFee: { value: '0.00', currency: 'USD' },
          shippingServices: [
            {
              shippingServiceCode: 'USPSPriority',
              sortOrderId: 1,
              freeShipping: false,
              buyerResponsibleForShipping: true,
              shippingCarrierCode: 'USPS',
            },
          ],
        },
      ];
    };

    let payload: any = {};
    if (path === 'payment_policy') {
      // Start from current and override selected fields
      payload = {
        ...cur,
        name: body.name ?? cur.name,
        marketplaceId: mp,
        categoryTypes: normalizeCategoryTypes(cur.categoryTypes),
        immediatePay: body.immediatePay ?? cur.immediatePay ?? false,
      };
      stripReadOnly(payload, [
        'paymentPolicyId',
        'policyId',
        'creationDate',
        'lastModifiedDate',
        '@odata.etag',
        'warnings',
      ]);
    } else if (path === 'fulfillment_policy') {
      const handlingDays = Number(body.handlingTimeDays ?? cur?.handlingTime?.value ?? 1);
      const shippingOptions = ensureFulfillmentShippingOptions(
        cur.shippingOptions,
        body.freeDomestic === true,
        body.shippingCarrierCode,
        body.shippingServiceCode
      );
      payload = {
        ...cur,
        name: body.name ?? cur.name,
        marketplaceId: mp,
        categoryTypes: normalizeCategoryTypes(cur.categoryTypes),
        handlingTime: { value: Math.max(0, handlingDays), unit: 'DAY' },
        shippingOptions,
      };
      stripReadOnly(payload, [
        'fulfillmentPolicyId',
        'policyId',
        'creationDate',
        'lastModifiedDate',
        '@odata.etag',
        'warnings',
      ]);
    } else if (path === 'return_policy') {
      const returnsAccepted = body.returnsAccepted ?? cur.returnsAccepted ?? true;
      const periodDays = Number(body.returnPeriodDays ?? cur?.returnPeriod?.value ?? 30);
      payload = returnsAccepted
        ? {
            ...cur,
            name: body.name ?? cur.name,
            marketplaceId: mp,
            categoryTypes: normalizeCategoryTypes(cur.categoryTypes),
            returnsAccepted: true,
            returnPeriod: { value: Math.max(1, periodDays), unit: 'DAY' },
            returnShippingCostPayer:
              body.returnShippingCostPayer ?? cur.returnShippingCostPayer ?? 'BUYER',
            refundMethod: body.refundMethod ?? cur.refundMethod ?? 'MONEY_BACK',
          }
        : {
            ...cur,
            name: body.name ?? cur.name,
            marketplaceId: mp,
            categoryTypes: normalizeCategoryTypes(cur.categoryTypes),
            returnsAccepted: false,
          };
      stripReadOnly(payload, [
        'returnPolicyId',
        'policyId',
        'creationDate',
        'lastModifiedDate',
        '@odata.etag',
        'warnings',
      ]);
    }

    const putRes = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify(payload) });
    const putTxt = await putRes.text(); let putBody: any; try { putBody = JSON.parse(putTxt); } catch { putBody = { raw: putTxt }; }
    if (!putRes.ok) return json({ error: 'update-policy failed', status: putRes.status, detail: putBody }, putRes.status);
    return json({ ok: true, policy: putBody });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
};
