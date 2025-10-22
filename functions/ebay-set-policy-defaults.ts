import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from './_auth.js';

export const handler: Handler = async (event) => {
  try {
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

    const body = event.body ? JSON.parse(event.body) : {};
    const fulfillment = body.fulfillment as string | undefined;
    const payment = body.payment as string | undefined;
    const ret = body.return as string | undefined;

    const store = tokensStore();
    const key = userScopedKey(sub, 'policy-defaults.json');
    let prefs: any = {};
    try { prefs = (await store.get(key, { type: 'json' })) as any; } catch {}
    if (!prefs || typeof prefs !== 'object') prefs = {};
    if (fulfillment != null) prefs.fulfillment = String(fulfillment || '').trim() || undefined;
    if (payment != null) prefs.payment = String(payment || '').trim() || undefined;
    if (ret != null) prefs.return = String(ret || '').trim() || undefined;
    // Clean undefined keys
    Object.keys(prefs).forEach((k) => { if (prefs[k] == null || prefs[k] === '') delete prefs[k]; });
    await store.set(key, JSON.stringify(prefs));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, defaults: prefs }) };
  } catch (e: any) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e?.message || String(e) }) };
  }
};
