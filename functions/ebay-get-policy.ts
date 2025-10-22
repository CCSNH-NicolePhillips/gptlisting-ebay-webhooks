import type { Handler } from '@netlify/functions';
import { requireAuth, json } from './_auth.js';
import { getUserAccessToken, apiHost, headers } from './_ebay.js';

export const handler: Handler = async (event) => {
  try {
    const auth = await requireAuth(event);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    const qs = event.queryStringParameters || {};
    const type = String(qs.type || '').toLowerCase();
    const id = String(qs.id || '').trim();
    if (!type || !id) return json({ error: 'missing type or id' }, 400);

    let token: string;
    try { token = await getUserAccessToken(auth.sub); } catch (e: any) {
      if (e?.code === 'ebay-not-connected') return json({ error: 'ebay-not-connected' }, 400);
      return json({ error: 'token-mint-failed', detail: e?.message || String(e) }, 500);
    }
    const host = apiHost();
    const h = headers(token);
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
    const r = await fetch(url, { headers: h });
    const t = await r.text(); let body: any; try { body = JSON.parse(t); } catch { body = { raw: t }; }
    if (!r.ok) return json({ error: 'get-policy failed', status: r.status, detail: body }, r.status);
    return json({ ok: true, policy: body });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
};
