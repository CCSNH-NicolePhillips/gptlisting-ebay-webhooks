import type { Handler } from '@netlify/functions';
import { json, userScopedKey, getBearerToken, getJwtSubUnverified, requireAuthVerified } from '../../src/lib/_auth.js';
import { getUserAccessToken, apiHost, headers } from '../../src/lib/_ebay.js';
import { tokensStore } from '../../src/lib/redis-store.js';

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
					const raw = service.sortOrderId;
					const parsed = Number(raw);
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

export const handler: Handler = async (event) => {
	try {
		// Verify auth (allow Auth0-verified or Netlify Identity tokens)
		const bearer = getBearerToken(event);
		let sub = (await requireAuthVerified(event))?.sub || null;
		if (!sub) sub = getJwtSubUnverified(event);
		if (!bearer || !sub) return json({ error: 'unauthorized' }, 401);

		const body = event.body ? JSON.parse(event.body) : {};
		const type = String(body.type || '').toLowerCase();
		if (!type) return json({ error: 'missing type' }, 400);

		// Mint eBay access token
		let token: string;
		try {
			token = await getUserAccessToken(sub, [
				'https://api.ebay.com/oauth/api_scope',
				'https://api.ebay.com/oauth/api_scope/sell.account',
			]);
		} catch (e: any) {
			if (e?.code === 'ebay-not-connected') return json({ error: 'ebay-not-connected' }, 400);
			return json({ error: 'token-mint-failed', detail: e?.message || String(e) }, 500);
		}
		const host = apiHost();
		const h = headers(token);
		const mp = h['X-EBAY-C-MARKETPLACE-ID'] || 'EBAY_US';

		const map: Record<string, string> = {
			payment: 'payment_policy',
			fulfillment: 'fulfillment_policy',
			shipping: 'fulfillment_policy',
			return: 'return_policy',
			returns: 'return_policy',
		};
		const path = map[type];
		if (!path) return json({ error: 'invalid type' }, 400);

		// Build payload
	let payload: any = {};
		if (path === 'payment_policy') {
			payload = {
				name: body.name || 'Payment Policy',
				marketplaceId: mp,
				categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
				immediatePay: !!body.immediatePay,
			};
		} else if (path === 'fulfillment_policy') {
			const handlingDays = Number(body.handlingTimeDays ?? 1);
			const freeDomestic = !!body.freeDomestic;
			const costType = (body.costType === 'FLAT_RATE') ? 'FLAT_RATE' : 'CALCULATED';
			let shippingOptions: any[] | undefined;
	const domesticShipTo = { shipToLocations: { regionIncluded: [{ regionType: 'COUNTRY', regionName: 'US' }] } };
			const shippingCostValueNum = Number(body.shippingCostValue);
			const additionalShippingCostValueNum = Number(body.additionalShippingCostValue);
			const hasShippingCost = Number.isFinite(shippingCostValueNum);
			const hasAdditionalCost = Number.isFinite(additionalShippingCostValueNum);
			if (freeDomestic) {
				shippingOptions = [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: true,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSPriorityFlatRateBox',
								sortOrder: 1,
								buyerResponsibleForShipping: false,
								buyerResponsibleForPickup: false,
							},
						],
						packageHandlingCost: { value: '0.00', currency: 'USD' },
						shippingDiscountProfileId: '0',
						shippingPromotionOffered: false,
						...domesticShipTo,
					},
				];
			} else if (body.shippingServiceCode) {
				const calcRate = costType === 'CALCULATED' ? (() => {
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
					return {
						measurementSystem,
						packageType,
						packageLength: { value: lengthVal.toString(), unit: dimUnit },
						packageWidth: { value: widthVal.toString(), unit: dimUnit },
						packageHeight: { value: heightVal.toString(), unit: dimUnit },
						weightMajor: { value: weightMajor.toString(), unit: majorUnit },
						weightMinor: { value: weightMinor.toString(), unit: minorUnit },
					};
				})() : null;
				shippingOptions = [
					{
						optionType: 'DOMESTIC',
						costType,
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: body.shippingCarrierCode || 'USPS',
								shippingServiceCode: body.shippingServiceCode,
								sortOrder: 1,
								buyerResponsibleForShipping: false,
								buyerResponsibleForPickup: false,
								...(costType === 'FLAT_RATE'
									? {
											shippingCost: {
												value: (hasShippingCost ? shippingCostValueNum : 0).toFixed(2),
												currency: 'USD',
											},
											...(hasAdditionalCost
												? {
														additionalShippingCost: {
															value: additionalShippingCostValueNum.toFixed(2),
															currency: 'USD',
														},
													}
												: {}),
										}
									: {}),
							},
						],
						...(calcRate ? { calculatedShippingRate: calcRate } : {}),
						packageHandlingCost: { value: '0.00', currency: 'USD' },
						shippingDiscountProfileId: '0',
						shippingPromotionOffered: false,
						...domesticShipTo,
					},
				];
			}
			payload = {
				name: body.name || 'Shipping Policy',
				marketplaceId: mp,
				categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
				handlingTime: { value: Math.max(0, isNaN(handlingDays) ? 1 : handlingDays), unit: 'DAY' },
				...(shippingOptions ? { shippingOptions } : {}),
				...domesticShipTo,
				globalShipping: false,
				pickupDropOff: false,
				freightShipping: false,
			};
			payload = sanitizeFulfillmentPayload(payload);
		} else if (path === 'return_policy') {
			const returnsAccepted = body.returnsAccepted !== false;
			const periodDays = Number(body.returnPeriodDays ?? 30);
			payload = returnsAccepted ? {
				name: body.name || 'Returns Policy',
				marketplaceId: mp,
				returnsAccepted: true,
				returnPeriod: { value: Math.max(1, isNaN(periodDays) ? 30 : periodDays), unit: 'DAY' },
				returnShippingCostPayer: body.returnShippingCostPayer || 'BUYER',
				refundMethod: body.refundMethod || 'MONEY_BACK',
			} : {
				name: body.name || 'No Returns Policy',
				marketplaceId: mp,
				returnsAccepted: false,
			};
		}

		// Create policy
	const res = await fetch(`${host}/sell/account/v1/${path}`, { method: 'POST', headers: h as any, body: JSON.stringify(payload) });
		const txt = await res.text(); let j: any; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
		if (!res.ok) {
			const www = res.headers.get('www-authenticate') || '';
			return json({ error: 'create-policy failed', status: res.status, auth: www, detail: j, sent: payload }, res.status);
		}

		// Extract ID returned by eBay
		const id = String(j?.id || j?.policyId || j?.paymentPolicyId || j?.fulfillmentPolicyId || j?.returnPolicyId || '').trim();

		// Optionally set as default
		let defaultsUpdated: any = null;
		if (id && body.setDefault) {
			try {
				const store = tokensStore();
				const key = userScopedKey(sub, 'policy-defaults.json');
				const cur = ((await store.get(key, { type: 'json' })) as any) || {};
				if (path === 'payment_policy') cur.payment = id;
				else if (path === 'fulfillment_policy') cur.fulfillment = id;
				else if (path === 'return_policy') cur.return = id;
				await store.set(key, JSON.stringify(cur));
				defaultsUpdated = cur;
				console.log(`[ebay-create-policy] Set default ${type} policy:`, id);
			} catch (e: any) {
				console.error(`[ebay-create-policy] Failed to set default policy:`, e);
				// Don't fail the entire request, but log the error
			}
		}

		return json({ ok: true, id, policy: j, defaults: defaultsUpdated });
	} catch (e: any) {
		return json({ error: e?.message || String(e) }, 500);
	}
};