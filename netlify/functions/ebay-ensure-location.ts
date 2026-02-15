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
		const host = apiHost();
		const h = headers(token);

		const body = event.body ? JSON.parse(event.body) : {};
		const reqKey = (body.merchantLocationKey || process.env.EBAY_MERCHANT_LOCATION_KEY || 'default-loc').toString();
		let reqAddr = body.address || null;
		// Fallback to environment-specified address if none provided
		if (!reqAddr) {
			const a1 = process.env.SHIP_ADDRESS1;
			const city = process.env.SHIP_CITY;
			const st = process.env.SHIP_STATE || process.env.SHIP_STATE_OR_PROVINCE;
			const pc = process.env.SHIP_POSTAL || process.env.SHIP_POSTAL_CODE;
			const ctry = process.env.SHIP_COUNTRY || 'US';
			if (a1 && city && st && pc) {
				reqAddr = { addressLine1: a1, city, stateOrProvince: st, postalCode: pc, country: ctry };
			}
		}

		// 1) If any location exists, return the first enabled one or first match by key
		const listUrl = `${host}/sell/inventory/v1/location?limit=200`;
		const listRes = await fetch(listUrl, { headers: h });
		const listTxt = await listRes.text();
		let listJson: any; try { listJson = JSON.parse(listTxt); } catch { listJson = { raw: listTxt }; }
		if (!listRes.ok) return json({ ok: false, error: 'list-locations-failed', status: listRes.status, detail: listJson }, listRes.status);
		const locations = Array.isArray(listJson?.locations) ? listJson.locations : [];

		const byKey = locations.find((l: any) => (l?.merchantLocationKey || '') === reqKey) || locations[0];
		if (byKey) {
			const key = byKey.merchantLocationKey || reqKey;
			const status = (byKey?.merchantLocationStatus || '').toUpperCase();
			if (status !== 'ENABLED') {
				// try to enable
				const enableUrl = `${host}/sell/inventory/v1/location/${encodeURIComponent(key)}/enable`;
				const enRes = await fetch(enableUrl, { method: 'POST', headers: h, body: JSON.stringify({}) });
				if (!(enRes.ok || enRes.status === 204)) {
					// Surface but still return key
					const enTxt = await enRes.text(); let enJ: any; try { enJ = JSON.parse(enTxt); } catch { enJ = { raw: enTxt }; }
					return json({ ok: false, error: 'enable-failed', status: enRes.status, detail: enJ });
				}
			}
			return json({ ok: true, merchantLocationKey: key });
		}

		// 2) None exist: require address to create
		if (!reqAddr || !reqAddr.addressLine1 || !reqAddr.city || !reqAddr.stateOrProvince || !reqAddr.postalCode || !reqAddr.country) {
			return json({ ok: false, error: 'missing-address', hint: 'Provide address { addressLine1, city, stateOrProvince, postalCode, country }' }, 400);
		}

		const createPayload = {
			name: process.env.SHIP_NAME || 'Default Location',
			merchantLocationKey: reqKey,
			merchantLocationStatus: 'ENABLED',
			locationTypes: ['WAREHOUSE'],
			location: { address: reqAddr },
		};
		const createUrl = `${host}/sell/inventory/v1/location`;
		const cRes = await fetch(createUrl, { method: 'POST', headers: h, body: JSON.stringify(createPayload) });
		if (cRes.status === 201 || cRes.status === 204 || cRes.status === 409) {
			return json({ ok: true, merchantLocationKey: reqKey });
		}
		const cTxt = await cRes.text(); let cJson: any; try { cJson = JSON.parse(cTxt); } catch { cJson = { raw: cTxt }; }
		return json({ ok: false, error: 'create-location-failed', status: cRes.status, detail: cJson }, cRes.status);
	} catch (e: any) {
		return json({ error: e?.message || String(e) }, 500);
	}
};