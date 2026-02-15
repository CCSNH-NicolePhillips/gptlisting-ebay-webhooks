import type { Handler } from '../../src/types/api-handler.js';
import { requireAuth, json } from '../../src/lib/_auth.js';
import { getUserAccessToken, apiHost, headers } from '../../src/lib/_ebay.js';

export const handler: Handler = async (event) => {
	try {
		const auth = await requireAuth(event);
		if (!auth) return json({ error: 'unauthorized' }, 401);
		let token: string;
		try { token = await getUserAccessToken(auth.sub); } catch (e: any) {
			if (e?.code === 'ebay-not-connected') return json({ error: 'ebay-not-connected' }, 400);
			return json({ error: 'token-mint-failed', detail: e?.message || String(e) }, 500);
		}
		const url = `${apiHost()}/sell/account/v1/program/opt_in`;
		const res = await fetch(url, { method: 'POST', headers: headers(token), body: JSON.stringify({ programType: 'SELLING_POLICY_MANAGEMENT' }) });
		const txt = await res.text(); let body: any; try { body = JSON.parse(txt); } catch { body = { raw: txt }; }
		if (res.status === 409) return json({ ok: true, submitted: false, already: true, note: 'Already opted in' });
		if (!res.ok) return json({ ok: false, error: 'optin-failed', status: res.status, detail: body }, res.status);
		return json({ ok: true, submitted: true, note: 'May take up to 24h to reflect' });
	} catch (e: any) {
		return json({ error: e?.message || String(e) }, 500);
	}
};
