import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';

export const handler: Handler = async () => {
  try {
    const store = tokensStore();
    const saved = (await store.get('ebay.json', { type: 'json' })) as any;
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

    async function getJson(path: string) {
      const res = await fetch(`${apiHost}${path}`, { headers });
      const text = await res.text();
      try {
        return { status: res.status, json: JSON.parse(text) };
      } catch {
        return { status: res.status, json: { raw: text } };
      }
    }

    const [fulfillment, payment, returns] = await Promise.all([
      getJson(`/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`),
      getJson(`/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`),
      getJson(`/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}`),
    ]);

    const hasNotEligible = [fulfillment, payment, returns].some((r) => {
      const errs = (r?.json as any)?.errors as any[] | undefined;
      return Array.isArray(errs) && errs.some((e) => e?.errorId === 20403);
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fulfillment,
        payment,
        returns,
        eligibility: hasNotEligible
          ? {
              businessPoliciesEligible: false,
              hint: 'This eBay account is not opted into Business Policies. Opt in at https://www.ebay.com/sh/str/selling-policies (Account settings > Selling > Business policies), then create Payment/Return/Shipping policies for EBAY_US.',
              marketplaceId: MARKETPLACE_ID,
            }
          : { businessPoliciesEligible: true, marketplaceId: MARKETPLACE_ID },
      }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e?.message || String(e) }),
    };
  }
};
