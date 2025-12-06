import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getJwtSubUnverified, userScopedKey, getBearerToken } from '../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';

export const handler: Handler = async (event) => {
	try {
		const store = tokensStore();
		const bearer = getBearerToken(event);
		const sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };
		
		const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) {
			return {
				statusCode: 400,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ok: false, error: 'Connect eBay first' }),
			};
		}

		// Get user's default promo campaign from marketing-defaults.json
		const marketingKey = userScopedKey(sub, 'marketing-defaults.json');
		let prefs: any = {};
		try {
			prefs = (await store.get(marketingKey, { type: 'json' })) as any;
		} catch {}
		if (!prefs || typeof prefs !== 'object') prefs = {};
		const defaultPromoCampaignId = prefs.defaultPromoCampaignId ?? null;

		// Get eBay access token and setup
		const { access_token } = await accessTokenFromRefresh(refresh);
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const MARKETPLACE_ID = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

		const headers = {
			Authorization: `Bearer ${access_token}`,
			'Content-Type': 'application/json',
			'Accept-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
		};

		// Fetch campaigns from eBay Marketing API
		const url = `${apiHost}/sell/marketing/v1/ad_campaign?limit=200`;
		const res = await fetch(url, { headers });
		
		if (!res.ok) {
			const errorText = await res.text();
			console.error('[ebay-list-campaigns] eBay API error:', res.status, errorText);
			return {
				statusCode: res.status,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					ok: false, 
					error: `eBay API error: ${res.status}`,
					detail: errorText.substring(0, 500),
				}),
			};
		}

		const raw = await res.json();
		
		// Map campaigns to clean format
		const campaigns = (raw.campaigns ?? []).map((c: any) => ({
			campaignId: c.campaignId,
			name: c.campaignName,
			status: c.campaignStatus,
			fundingStrategyType: c.fundingStrategy?.fundingModel ?? null,
		}));

		console.log(`[ebay-list-campaigns] Found ${campaigns.length} campaigns for user ${sub}`);

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ok: true,
				defaultPromoCampaignId,
				campaigns,
			}),
		};
	} catch (e: any) {
		console.error('[ebay-list-campaigns] Error:', e);
		return {
			statusCode: 500,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
		};
	}
};
