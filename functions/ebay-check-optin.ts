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
    const url = `${apiHost()}/sell/account/v1/program/get_opted_in_programs`;
    const res = await fetch(url, { headers: headers(token) });
    const txt = await res.text();
    let body: any; try { body = JSON.parse(txt); } catch { body = { raw: txt }; }
    if (!res.ok) return json({ ok: false, status: res.status, error: 'check-optin-failed', detail: body }, res.status);
    const programs: any[] = Array.isArray(body?.programs) ? body.programs : [];
    const matched = programs.find((p) => {
      const type = (p?.programType || '').toString().toUpperCase();
      if (!type) return false;
      if (type === 'SELLING_POLICY_MANAGEMENT') return true;
      if (type === 'SELLING_POLICIES') return true;
      return type.includes('POLICY');
    });
    const status = (matched?.status || '').toString().toUpperCase();
    const optedIn = matched?.optedIn === true || status === 'OPTED_IN';
    const payload: Record<string, unknown> = { ok: true, optedIn };
    if (status) payload.status = status;
    if (matched?.programType || matched?.optedIn !== undefined) {
      payload.detail = {
        programType: matched?.programType,
        optedIn: matched?.optedIn,
        status: matched?.status,
      };
    }
    if (!matched && programs.length) {
      payload.programs = programs.slice(0, 5).map((p) => ({
        programType: p?.programType,
        optedIn: p?.optedIn,
        status: p?.status,
      }));
    }
    return json(payload);
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
};
