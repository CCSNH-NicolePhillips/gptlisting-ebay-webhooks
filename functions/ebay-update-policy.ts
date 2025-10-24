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

    // Helper: normalize categoryTypes without deprecated 'default' flag
    const normalizeCategoryTypes = (ct: any): any[] => {
      const arr: any[] = Array.isArray(ct) && ct.length ? ct : [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];
      return arr.map((x) => ({ name: x?.name || 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }));
    };

    const stripReadOnly = (obj: any, keys: string[]) => {
      for (const k of keys) delete obj[k];
      return obj;
    };

    const ensureFulfillmentShippingOptions = (
      curOptions: any,
      forceFreeDomestic: boolean,
      selectedCostType?: 'CALCULATED' | 'FLAT_RATE',
      carrier?: string,
      serviceCode?: string,
      shippingCostValue?: string,
      additionalShippingCostValue?: string
    ) => {
      const baseShipTo = { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] };
      const normalizeServices = (services: any[]) =>
        Array.isArray(services)
          ? services.map((svc, idx) => {
              const next = { ...svc };
              if (next.sortOrder == null) {
                const parsed = Number(next.sortOrderId);
                next.sortOrder = Number.isFinite(parsed) ? parsed : idx + 1;
              }
              delete next.sortOrderId;
              if (next.shippingCost && typeof next.shippingCost.value === 'number') {
                next.shippingCost = {
                  ...next.shippingCost,
                  value: next.shippingCost.value.toFixed(2),
                };
              }
              if (next.additionalShippingCost && typeof next.additionalShippingCost.value === 'number') {
                next.additionalShippingCost = {
                  ...next.additionalShippingCost,
                  value: next.additionalShippingCost.value.toFixed(2),
                };
              }
              return next;
            })
          : services;

      const wrapOption = (partial: any) => ({
        optionType: 'DOMESTIC',
        shipToLocations: baseShipTo,
        ...partial,
      });

      if (forceFreeDomestic) {
        return [
          wrapOption({
            costType: 'FLAT_RATE',
            shippingServices: normalizeServices([
              {
                shippingServiceCode: 'USPSGroundAdvantage',
                sortOrder: 1,
                freeShipping: true,
                shippingCarrierCode: 'USPS',
              },
            ]),
          }),
        ];
      }

      if (serviceCode) {
        const shipCarrier = carrier || 'USPS';
        return [
          wrapOption({
            costType: selectedCostType || 'CALCULATED',
            shippingServices: normalizeServices([
              {
                shippingServiceCode: serviceCode,
                freeShipping: false,
                sortOrder: 1,
                ...(selectedCostType === 'FLAT_RATE'
                  ? { shippingCost: { value: shippingCostValue || '0.00', currency: 'USD' } }
                  : {}),
                ...(additionalShippingCostValue
                  ? { additionalShippingCost: { value: additionalShippingCostValue, currency: 'USD' } }
                  : {}),
                shippingCarrierCode: shipCarrier,
              },
            ]),
          }),
        ];
      }

      if (Array.isArray(curOptions) && curOptions.length) {
        return curOptions.map((opt: any) => {
          const next = { ...opt };
          delete next.insuranceFee;
          next.shipToLocations = next.shipToLocations || baseShipTo;
          next.shippingServices = normalizeServices(next.shippingServices);
          return next;
        });
      }

      return [
        wrapOption({
          costType: selectedCostType || 'CALCULATED',
          shippingServices: normalizeServices([
            {
              shippingServiceCode: 'USPSGroundAdvantage',
              freeShipping: false,
              sortOrder: 1,
              ...(selectedCostType === 'FLAT_RATE'
                ? { shippingCost: { value: shippingCostValue || '0.00', currency: 'USD' } }
                : {}),
              shippingCarrierCode: 'USPS',
            },
          ]),
        }),
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
        (body.costType as any) || undefined,
        body.shippingCarrierCode,
        body.shippingServiceCode,
        body.shippingCostValue,
        body.additionalShippingCostValue
      );
      // Build a minimal, valid payload to avoid sending read-only/unsupported fields
      payload = {
        name: body.name ?? cur.name,
        marketplaceId: mp,
        categoryTypes: normalizeCategoryTypes(cur.categoryTypes),
        handlingTime: { value: Math.max(0, handlingDays), unit: 'DAY' },
        shippingOptions,
        shipToLocations: { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] },
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
            name: body.name ?? cur.name,
            marketplaceId: mp,
            returnsAccepted: true,
            returnPeriod: { value: Math.max(1, periodDays), unit: 'DAY' },
            returnShippingCostPayer:
              body.returnShippingCostPayer ?? cur.returnShippingCostPayer ?? 'BUYER',
            refundMethod: body.refundMethod ?? cur.refundMethod ?? 'MONEY_BACK',
          }
        : {
            name: body.name ?? cur.name,
            marketplaceId: mp,
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
