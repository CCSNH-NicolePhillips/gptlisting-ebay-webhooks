import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';

function normalizeMoney(input: any, fallbackCurrency = 'USD', fallbackValue = '0.00') {
	if (!input || typeof input !== 'object') {
		return { value: fallbackValue, currency: fallbackCurrency };
	}
	const currency = input.currency || fallbackCurrency;
	const rawVal = input.value;
	if (typeof rawVal === 'string') {
		return { value: rawVal, currency };
	}
	const num = Number(rawVal);
	return {
		value: Number.isFinite(num) ? num.toFixed(2) : fallbackValue,
		currency,
	};
}

function sanitizeFulfillmentPayload(payload: any) {
	if (!payload || typeof payload !== 'object') return payload;
	payload.globalShipping = !!payload.globalShipping;
	payload.pickupDropOff = !!payload.pickupDropOff;
	payload.freightShipping = !!payload.freightShipping;
	if (!payload.shipToLocations) payload.shipToLocations = { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] };
	if (!Array.isArray(payload.shippingOptions)) return payload;

	payload.shippingOptions = payload.shippingOptions.map((option: any, optIdx: number) => {
		if (!option || typeof option !== 'object') return option;
		const normalized = { ...option };
		delete normalized.insuranceFee;
		if (!normalized.shipToLocations) normalized.shipToLocations = { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] };

		normalized.packageHandlingCost = normalizeMoney(normalized.packageHandlingCost);
		normalized.shippingDiscountProfileId = normalized.shippingDiscountProfileId != null
			? String(normalized.shippingDiscountProfileId)
			: '0';
		normalized.shippingPromotionOffered = !!normalized.shippingPromotionOffered;

		if (Array.isArray(normalized.shippingServices)) {
			normalized.shippingServices = normalized.shippingServices.map((svc: any, svcIdx: number) => {
				if (!svc || typeof svc !== 'object') return svc;
				const service = { ...svc };
				if (service.sortOrder == null) {
					const parsed = Number(service.sortOrderId);
					service.sortOrder = Number.isFinite(parsed) ? parsed : svcIdx + 1;
				}
				delete service.sortOrderId;
				if (service.shippingCost && typeof service.shippingCost.value === 'number') {
					service.shippingCost = {
						...service.shippingCost,
						value: service.shippingCost.value.toFixed(2),
					};
				}
				if (service.additionalShippingCost && typeof service.additionalShippingCost.value === 'number') {
					service.additionalShippingCost = {
						...service.additionalShippingCost,
						value: service.additionalShippingCost.value.toFixed(2),
					};
				}
				service.buyerResponsibleForShipping = !!service.buyerResponsibleForShipping;
				service.buyerResponsibleForPickup = !!service.buyerResponsibleForPickup;
				return service;
			});
		}
		if (!Array.isArray(normalized.shippingServices)) normalized.shippingServices = [];

		if (normalized.calculatedShippingRate) {
			const calc = { ...normalized.calculatedShippingRate };
			const fixDim = (dim: any) => {
				if (!dim || typeof dim !== 'object') return dim;
				const val = dim.value;
				return typeof val === 'string' ? dim : { ...dim, value: val != null ? String(val) : val };
			};
			calc.packageLength = fixDim(calc.packageLength);
			calc.packageWidth = fixDim(calc.packageWidth);
			calc.packageHeight = fixDim(calc.packageHeight);
			calc.weightMajor = fixDim(calc.weightMajor);
			calc.weightMinor = fixDim(calc.weightMinor);
			calc.measurementSystem = (calc.measurementSystem || 'ENGLISH').toString().toUpperCase();
			normalized.calculatedShippingRate = calc;
		}

		return normalized;
	});

	return payload;
}

function json(body: any, status: number = 200) {
	return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
	try {
		// Verify caller has a bearer token and extract user sub
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return json({ ok: false, error: 'Unauthorized' }, 401);

		// Load user's eBay refresh token
		const store = tokensStore();
		const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
		const refresh = saved?.refresh_token as string | undefined;
		if (!refresh) return json({ ok: false, error: 'Connect eBay first' }, 400);

		// Mint user access token with sell.account scope for Account API
		const scopes = [
			'https://api.ebay.com/oauth/api_scope',
			'https://api.ebay.com/oauth/api_scope/sell.account',
		];
		const { access_token } = await accessTokenFromRefresh(refresh, scopes);

		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const headers = {
			Authorization: `Bearer ${access_token}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'Content-Language': 'en-US',
			'Accept-Language': 'en-US',
			'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
		} as Record<string, string>;

		// Build minimal, known-good payload
		const body = event.body ? JSON.parse(event.body) : {};
		const name = String(body.name || 'App Default USPS');
		const handlingTimeVal = Number(body.handlingTime ?? 3);
		const free = !!body.free;
		const costType = String(body.costType || (free ? 'FLAT_RATE' : 'CALCULATED')).toUpperCase();
	const serviceCode = String(body.serviceCode || (free ? 'USPSPriorityFlatRateBox' : 'USPSParcel'));
		const flatRate = body.flatRate != null ? String(Number(body.flatRate).toFixed(2)) : '5.99';
		const measurementSystem = (body.calcMeasurementSystem === 'METRIC') ? 'METRIC' : 'ENGLISH';
		const packageType = body.calcPackageType || 'PACKAGE_THICK_ENVELOPE';
		const toNum = (val: any, def: number) => {
			const n = Number(val);
			return Number.isFinite(n) && n >= 0 ? n : def;
		};
		const lengthVal = toNum(body.calcLength, measurementSystem === 'METRIC' ? 30 : 12);
		const widthVal = toNum(body.calcWidth, measurementSystem === 'METRIC' ? 20 : 9);
		const heightVal = toNum(body.calcHeight, measurementSystem === 'METRIC' ? 8 : 3);
		const weightMajor = toNum(body.calcWeightMajor, measurementSystem === 'METRIC' ? 1 : 1);
		const weightMinor = toNum(body.calcWeightMinor, 0);
		const dimUnit = measurementSystem === 'METRIC' ? 'CENTIMETER' : 'INCH';
		const majorUnit = measurementSystem === 'METRIC' ? 'KILOGRAM' : 'POUND';
		const minorUnit = measurementSystem === 'METRIC' ? 'GRAM' : 'OUNCE';


		let payload = {
			name,
			marketplaceId: MARKETPLACE_ID,
			categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
			handlingTime: { value: Math.max(0, isNaN(handlingTimeVal) ? 3 : handlingTimeVal), unit: 'DAY' },
			shippingOptions: [
				{
					optionType: 'DOMESTIC',
					costType: free ? 'FLAT_RATE' : costType,
					shippingServices: [
						{
							shippingCarrierCode: 'USPS',
							shippingServiceCode: serviceCode,
							freeShipping: free,
							...(free || costType === 'CALCULATED'
								? {}
								: { shippingCost: { value: flatRate, currency: 'USD' } }),
							sortOrder: 1,
							buyerResponsibleForShipping: false,
							buyerResponsibleForPickup: false,
						},
					],
					shipToLocations: { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] },
					packageHandlingCost: { value: '0.00', currency: 'USD' },
					shippingDiscountProfileId: '0',
					shippingPromotionOffered: false,
					...(free || costType !== 'CALCULATED'
						? {}
						: {
								calculatedShippingRate: {
									measurementSystem,
									packageType,
									packageLength: { value: lengthVal.toString(), unit: dimUnit },
									packageWidth: { value: widthVal.toString(), unit: dimUnit },
									packageHeight: { value: heightVal.toString(), unit: dimUnit },
									weightMajor: { value: weightMajor.toString(), unit: majorUnit },
									weightMinor: { value: weightMinor.toString(), unit: minorUnit },
								},
							}),
				},
			],
			shipToLocations: { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] },
			globalShipping: false,
			pickupDropOff: false,
			freightShipping: false,
		};
		payload = sanitizeFulfillmentPayload(payload);

		const url = `${apiHost}/sell/account/v1/fulfillment_policy`;
		const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
		const txt = await res.text();
		let resBody: any; try { resBody = JSON.parse(txt); } catch { resBody = txt; }
		const www = res.headers.get('www-authenticate') || '';
		if (!res.ok) return json({ error: 'create-policy failed', status: res.status, wwwAuthenticate: www, detail: resBody, sent: payload }, res.status);
		return json({ ok: true, policy: resBody }, 200);
	} catch (e: any) {
		return json({ ok: false, error: 'policy-create fatal', detail: e?.message || String(e) }, 500);
	}
};