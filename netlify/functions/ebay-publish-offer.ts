import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const body = event.body ? JSON.parse(event.body) : {};
		const offerId = event.queryStringParameters?.offerId || body.offerId;
		const conditionRaw = event.queryStringParameters?.condition ?? body.condition; // optional numeric
		if (!offerId) return { statusCode: 400, body: JSON.stringify({ error: 'missing offerId' }) };
	const store = tokensStore();
	const bearer = getBearerToken(event);
	let sub = (await requireAuthVerified(event))?.sub || null;
	if (!sub) sub = getJwtSubUnverified(event);
	if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };
	const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
		const { access_token } = await accessTokenFromRefresh(refresh);
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const headers = {
			Authorization: `Bearer ${access_token}`,
			Accept: 'application/json',
			'Content-Language': 'en-US',
			'Accept-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
			'Content-Type': 'application/json',
		} as Record<string, string>;

		async function publishOnce() {
			const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`;
			const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) });
			const txt = await r.text();
			let json: any;
			try {
				json = JSON.parse(txt);
			} catch {
				json = { raw: txt };
			}
			return { ok: r.ok, status: r.status, body: json, url };
		}

		let pub = await publishOnce();
		// If publish fails due to invalid/missing condition (25021), attempt to update offer with numeric condition and retry once
		const errors = ([] as any[]).concat(pub.body?.errors || pub.body || []);
		const needsCondFix = !pub.ok && errors.some((e) => Number(e?.errorId) === 25021);
		if (needsCondFix) {
			// Fetch current offer
			const getUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			const getRes = await fetch(getUrl, { headers });
			const getTxt = await getRes.text();
			let offer: any;
			try {
				offer = JSON.parse(getTxt);
			} catch {
				offer = {};
			}
			if (!getRes.ok) {
				return {
					statusCode: pub.status,
					body: JSON.stringify({
						error: 'publish failed',
						status: pub.status,
						detail: pub.body,
						note: 'also failed to fetch offer to auto-fix condition',
						getUrl,
						getRes: offer,
					}),
				};
			}
			const condNum = Number(conditionRaw ?? offer?.condition ?? 1000);
			const updatePayload: any = {
				sku: offer?.sku,
				marketplaceId: offer?.marketplaceId,
				format: offer?.format || 'FIXED_PRICE',
				availableQuantity: offer?.availableQuantity,
				categoryId: offer?.categoryId,
				listingDescription: offer?.listingDescription,
				pricingSummary: offer?.pricingSummary,
				listingPolicies: offer?.listingPolicies,
				merchantLocationKey: offer?.merchantLocationKey,
				condition: Number.isFinite(condNum) ? condNum : 1000,
			};
			const putUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
			const putRes = await fetch(putUrl, {
				method: 'PUT',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(updatePayload),
			});
			const putTxt = await putRes.text();
			let putJson: any;
			try {
				putJson = JSON.parse(putTxt);
			} catch {
				putJson = { raw: putTxt };
			}
			if (!putRes.ok) {
				return {
					statusCode: pub.status,
					body: JSON.stringify({
						error: 'publish failed',
						status: pub.status,
						detail: pub.body,
						note: 'failed to update offer condition before retry',
						update: { url: putUrl, status: putRes.status, body: putJson },
					}),
				};
			}
			// retry publish once
			pub = await publishOnce();
		}
	if (!pub.ok) {
			// Auto-delete the problematic draft as requested
			try {
				const delUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
				const delRes = await fetch(delUrl, { method: 'DELETE', headers });
				if (delRes.ok) {
					return {
						statusCode: 200,
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							ok: true,
							deleted: true,
							offerId,
							reason: 'publish failed',
							publish: { url: pub.url, status: pub.status, detail: pub.body },
						}),
					};
				} else {
					const delTxt = await delRes.text();
					let delBody: any;
					try {
						delBody = JSON.parse(delTxt);
					} catch {
						delBody = { raw: delTxt };
					}
					return {
						statusCode: pub.status,
						body: JSON.stringify({
							error: 'publish failed; also failed to delete',
							publish: { url: pub.url, status: pub.status, detail: pub.body },
							delete: { url: delUrl, status: delRes.status, detail: delBody },
						}),
					};
				}
			} catch (e: any) {
				return {
					statusCode: pub.status,
					body: JSON.stringify({
						error: 'publish failed; delete attempt errored',
						publish: { url: pub.url, status: pub.status, detail: pub.body },
						deleteError: e?.message || String(e),
					}),
				};
			}
		}
		// Success: record that this offer was published so we can hide it from future 'drafts' after it is ended/unlisted.
		try {
	const store2 = tokensStore();
	const key = userScopedKey(sub!, 'published.json');
	const cur = ((await store2.get(key, { type: 'json' })) as any) || {};
			const stamp = new Date().toISOString();
			// Try to capture SKU from offer body if present
	let sku: string | undefined = undefined;
	try { sku = pub.body?.sku ? String(pub.body.sku) : undefined; } catch {}
			cur[String(offerId)] = { offerId: String(offerId), sku, publishedAt: stamp };
	await store2.set(key, JSON.stringify(cur));
		} catch {
			// ignore persistence errors
		}
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true, result: pub.body }),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			body: JSON.stringify({ error: 'publish-offer error', detail: e?.message || String(e) }),
		};
	}
};
