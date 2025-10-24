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
    const normalize = (val: unknown) => (val == null ? '' : String(val)).trim().toUpperCase();
    const looksLikePolicies = (p: any) => {
      const type = normalize(p?.programType);
      if (!type) return false;
      if (type === 'SELLING_POLICY_MANAGEMENT') return true;
      if (type === 'SELLING_POLICIES') return true;
      if (type === 'BUSINESS_POLICIES') return true;
      if (type === 'BUSINESS_POLICY_MANAGEMENT') return true;
      return type.includes('POLICY');
    };
    const truthyStatuses = ['OPTED_IN', 'ACTIVE', 'ENROLLED', 'ENABLED'];
    const isProgramOptedIn = (p: any) => {
      const rawFlag = p?.optedIn;
      if (rawFlag === true) return true;
      const rawStr = normalize(rawFlag);
      if (rawStr && (rawStr === 'TRUE' || rawStr === 'YES' || rawStr === 'Y')) return true;
      if (truthyStatuses.includes(rawStr)) return true;
      const status = normalize(p?.status);
      if (truthyStatuses.includes(status)) return true;
      return false;
    };
    const policyPrograms = programs.filter(looksLikePolicies);
    const optedIn = policyPrograms.some(isProgramOptedIn) || policyPrograms.length > 0;
    const representative = policyPrograms.find(isProgramOptedIn) || policyPrograms[0] || null;
    const payload: Record<string, unknown> = { ok: true, optedIn };
    if (representative) {
      const status = normalize(representative?.status || representative?.optedIn || '');
      if (!status && optedIn) {
        payload.status = 'OPTED_IN';
      }
      if (status) payload.status = status;
      payload.detail = {
        programType: representative?.programType,
        optedIn: representative?.optedIn,
        status: representative?.status,
      };
    }
    const subset = policyPrograms.length ? policyPrograms : programs;
    if (subset.length) {
      payload.programs = subset.slice(0, 5).map((p) => ({
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
