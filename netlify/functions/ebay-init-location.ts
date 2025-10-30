import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';

function tryJson(t: string) {
	try {
		return JSON.parse(t);
	} catch {
		return t;
	}
}

export const handler: Handler = async (event) => {
	try {
		// Prefer stored user token; fallback to env diagnostic token
		const store = tokensStore();
		const saved = (await store.get('ebay.json', { type: 'json' })) as any;
		const refresh =
			(saved?.refresh_token as string | undefined) ||
			(process.env.EBAY_TEST_REFRESH_TOKEN as string | undefined);
		if (!refresh)
			return {
				statusCode: 400,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ error: 'Connect eBay first or set EBAY_TEST_REFRESH_TOKEN.' }),
			};

		const { access_token } = await accessTokenFromRefresh(refresh);
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const qs = (event?.queryStringParameters || {}) as Record<string, string>;
		const keyRaw = qs['key'] || process.env.EBAY_MERCHANT_LOCATION_KEY || 'default-loc';
		const key = String(keyRaw).trim().replace(/\s+/g, '-');

		const name = (qs['name'] || process.env.SHIP_NAME || 'Home').toString();
		const addressLine1 = (
			qs['address1'] ||
			process.env.SHIP_ADDRESS1 ||
			'Address line 1'
		).toString();
		const city = (qs['city'] || process.env.SHIP_CITY || 'City').toString();
		const stateOrProvince = (qs['state'] || process.env.SHIP_STATE || 'ST').toString();
		const postalCode = (qs['postal'] || process.env.SHIP_POSTAL || '00000').toString();
		const country = ((qs['country'] || process.env.SHIP_COUNTRY || 'US') as string).toUpperCase();
		const phone = (qs['phone'] || process.env.SHIP_PHONE || '6038511950').toString();
		const lat = qs['lat'] ? parseFloat(qs['lat']) : undefined;
		const lng = qs['lng'] ? parseFloat(qs['lng']) : undefined;
		const omitTypes = String(qs['omitTypes'] || 'false').toLowerCase() === 'true';
		const minimal = String(qs['minimal'] || 'false').toLowerCase() === 'true';
		const noPhone = String(qs['noPhone'] || 'false').toLowerCase() === 'true';
		const noHours = String(qs['noHours'] || 'false').toLowerCase() === 'true';

		const payload: any = {
			name,
			merchantLocationStatus: 'ENABLED',
			merchantLocationKey: key,
			location: {
				address: {
					addressLine1,
					city,
					stateOrProvince,
					postalCode,
					country,
				},
				...(lat !== undefined && lng !== undefined
					? { geoCoordinates: { latitude: lat, longitude: lng } }
					: {}),
				...(!minimal && !noPhone ? { phone } : {}),
				...(!minimal && !noHours
					? {
							operatingHours: [
								{ dayOfWeekEnum: 'MONDAY', interval: [{ open: '09:00:00', close: '17:00:00' }] },
								{ dayOfWeekEnum: 'TUESDAY', interval: [{ open: '09:00:00', close: '17:00:00' }] },
								{ dayOfWeekEnum: 'WEDNESDAY', interval: [{ open: '09:00:00', close: '17:00:00' }] },
								{ dayOfWeekEnum: 'THURSDAY', interval: [{ open: '09:00:00', close: '17:00:00' }] },
								{ dayOfWeekEnum: 'FRIDAY', interval: [{ open: '09:00:00', close: '17:00:00' }] },
							],
						}
					: {}),
			},
		};
		if (!omitTypes) payload.locationTypes = ['WAREHOUSE'];

		const url = `${apiHost}/sell/inventory/v1/location`;
		// Prefer POST /location/{key} per eBay docs
		const postUrl = `${apiHost}/sell/inventory/v1/location/${encodeURIComponent(key)}`;
		let resp = await fetch(postUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${access_token}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'Accept-Language': 'en-US',
				'Content-Language': 'en-US',
				'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
			},
			body: JSON.stringify(payload),
		});

		if (resp.status === 201 || resp.status === 409) {
			return {
				statusCode: 200,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ok: true, key, status: resp.status, methodUsed: 'POST /location' }),
			};
		}
		let text = await resp.text();
		let parsed = tryJson(text);
		// Fallback: try PUT /location/{key} if POST got a generic 2004
		const shouldFallback = resp.status === 400 && parsed?.errors?.[0]?.errorId === 2004;
		if (shouldFallback) {
			const putUrl = `${apiHost}/sell/inventory/v1/location/${encodeURIComponent(key)}`;
			resp = await fetch(putUrl, {
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${access_token}`,
					'Content-Type': 'application/json',
					Accept: 'application/json',
					'Accept-Language': 'en-US',
					'Content-Language': 'en-US',
					'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
				},
				body: JSON.stringify(payload),
			});
			if ([200, 201, 204, 409].includes(resp.status)) {
				return {
					statusCode: 200,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						ok: true,
						key,
						status: resp.status,
						methodUsed: 'PUT /location/{key}',
					}),
				};
			}
			text = await resp.text();
			parsed = tryJson(text);
			return {
				statusCode: resp.status,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					error: 'both-post-and-put-failed',
					postUrl,
					putUrl,
					status: resp.status,
					marketplaceId: MARKETPLACE_ID,
					payload,
					response: parsed,
				}),
			};
		}
		return {
			statusCode: resp.status,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				error: 'post-location failed',
				status: resp.status,
				url: postUrl,
				marketplaceId: MARKETPLACE_ID,
				payload,
				response: parsed,
			}),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ error: `init-location error: ${e.message}` }),
		};
	}
};