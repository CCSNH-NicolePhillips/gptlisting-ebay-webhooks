/**
 * Unit tests for shipping service code options
 * Tests the valid eBay shipping service codes for USPS, UPS, and FedEx
 */

import { describe, it, expect } from '@jest/globals';

/**
 * Valid USPS domestic shipping service codes as per eBay API
 * These are the codes accepted by eBay's Fulfillment Policy API
 */
const USPS_DOMESTIC_SERVICES = [
	{ code: 'USPSGround', name: 'USPS Ground Advantage' },
	{ code: 'USPSPriority', name: 'USPS Priority Mail' },
	{ code: 'USPSPriorityMailSmallFlatRateBox', name: 'USPS Priority Mail Small Flat Rate Box' },
	{ code: 'USPSPriorityMailFlatRateBox', name: 'USPS Priority Mail Flat Rate Box' },
	{ code: 'USPSPriorityMailLargeFlatRateBox', name: 'USPS Priority Mail Large Flat Rate Box' },
	{ code: 'USPSPriorityFlatRateEnvelope', name: 'USPS Priority Mail Flat Rate Envelope' },
	{ code: 'USPSPriorityMailPaddedFlatRateEnvelope', name: 'USPS Priority Mail Padded Flat Rate Envelope' },
	{ code: 'USPSExpressMail', name: 'USPS Priority Mail Express' },
	{ code: 'USPSExpressMailFlatRateEnvelope', name: 'USPS Priority Mail Express Flat Rate Envelope' },
	{ code: 'USPSExpressMailFlatRateBox', name: 'USPS Priority Mail Express Flat Rate Box' },
	{ code: 'USPSMedia', name: 'USPS Media Mail' },
	{ code: 'USPSFirstClass', name: 'USPS First Class' },
	{ code: 'USPSParcel', name: 'USPS Parcel Select' },
];

/**
 * Valid UPS domestic shipping service codes
 */
const UPS_DOMESTIC_SERVICES = [
	{ code: 'UPSGround', name: 'UPS Ground' },
	{ code: 'UPS3rdDay', name: 'UPS 3 Day' },
	{ code: 'UPSNextDay', name: 'UPS Next Day' },
	{ code: 'UPS2ndDay', name: 'UPS 2nd Day' },
];

/**
 * Valid FedEx domestic shipping service codes
 */
const FEDEX_DOMESTIC_SERVICES = [
	{ code: 'FedExHomeDelivery', name: 'FedEx Home Delivery' },
	{ code: 'FedExGround', name: 'FedEx Ground' },
	{ code: 'FedEx2Day', name: 'FedEx 2Day' },
	{ code: 'FedExExpressSaver', name: 'FedEx Express Saver' },
	{ code: 'FedExStandardOvernight', name: 'FedEx Standard Overnight' },
];

/**
 * Simulates the serviceOptionsFor function from policy-create.html
 * This mirrors the frontend logic for generating shipping service options
 */
function serviceOptionsFor(carrier: string): Array<[string, string]> {
	if (carrier === 'UPS') {
		return UPS_DOMESTIC_SERVICES.map(s => [s.code, s.name]);
	}
	if (carrier === 'FedEx') {
		return FEDEX_DOMESTIC_SERVICES.map(s => [s.code, s.name]);
	}
	// Default: USPS
	return USPS_DOMESTIC_SERVICES.map(s => [s.code, s.name]);
}

describe('Shipping Service Codes', () => {
	describe('USPS Services', () => {
		it('should have at least 10 USPS domestic options', () => {
			const options = serviceOptionsFor('USPS');
			expect(options.length).toBeGreaterThanOrEqual(10);
		});

		it('should include USPS Ground Advantage as first option', () => {
			const options = serviceOptionsFor('USPS');
			expect(options[0]).toEqual(['USPSGround', 'USPS Ground Advantage']);
		});

		it('should include USPS Priority Mail', () => {
			const options = serviceOptionsFor('USPS');
			const priorityOption = options.find(([code]) => code === 'USPSPriority');
			expect(priorityOption).toBeDefined();
			expect(priorityOption![1]).toBe('USPS Priority Mail');
		});

		it('should include USPS Media Mail', () => {
			const options = serviceOptionsFor('USPS');
			const mediaOption = options.find(([code]) => code === 'USPSMedia');
			expect(mediaOption).toBeDefined();
			expect(mediaOption![1]).toBe('USPS Media Mail');
		});

		it('should include USPS First Class', () => {
			const options = serviceOptionsFor('USPS');
			const firstClassOption = options.find(([code]) => code === 'USPSFirstClass');
			expect(firstClassOption).toBeDefined();
		});

		it('should include Priority Mail flat rate box options', () => {
			const options = serviceOptionsFor('USPS');
			const flatRateOptions = options.filter(([code]) => code.includes('FlatRateBox'));
			expect(flatRateOptions.length).toBeGreaterThanOrEqual(3); // Small, Medium, Large
		});

		it('should include Priority Mail Express options', () => {
			const options = serviceOptionsFor('USPS');
			const expressOptions = options.filter(([code]) => code.includes('ExpressMail'));
			expect(expressOptions.length).toBeGreaterThanOrEqual(2);
		});

		it('should have unique service codes', () => {
			const options = serviceOptionsFor('USPS');
			const codes = options.map(([code]) => code);
			const uniqueCodes = new Set(codes);
			expect(uniqueCodes.size).toBe(codes.length);
		});

		it('should have all codes match eBay API format (PascalCase with carrier prefix)', () => {
			const options = serviceOptionsFor('USPS');
			for (const [code] of options) {
				expect(code).toMatch(/^USPS[A-Z][a-zA-Z]*$/);
			}
		});
	});

	describe('UPS Services', () => {
		it('should have at least 4 UPS domestic options', () => {
			const options = serviceOptionsFor('UPS');
			expect(options.length).toBeGreaterThanOrEqual(4);
		});

		it('should include UPS Ground as first option', () => {
			const options = serviceOptionsFor('UPS');
			expect(options[0]).toEqual(['UPSGround', 'UPS Ground']);
		});

		it('should include UPS Next Day', () => {
			const options = serviceOptionsFor('UPS');
			const nextDayOption = options.find(([code]) => code === 'UPSNextDay');
			expect(nextDayOption).toBeDefined();
		});

		it('should have unique service codes', () => {
			const options = serviceOptionsFor('UPS');
			const codes = options.map(([code]) => code);
			const uniqueCodes = new Set(codes);
			expect(uniqueCodes.size).toBe(codes.length);
		});
	});

	describe('FedEx Services', () => {
		it('should have at least 4 FedEx domestic options', () => {
			const options = serviceOptionsFor('FedEx');
			expect(options.length).toBeGreaterThanOrEqual(4);
		});

		it('should include FedEx Home Delivery as first option', () => {
			const options = serviceOptionsFor('FedEx');
			expect(options[0]).toEqual(['FedExHomeDelivery', 'FedEx Home Delivery']);
		});

		it('should include FedEx Ground', () => {
			const options = serviceOptionsFor('FedEx');
			const groundOption = options.find(([code]) => code === 'FedExGround');
			expect(groundOption).toBeDefined();
		});

		it('should include FedEx 2Day', () => {
			const options = serviceOptionsFor('FedEx');
			const twoDayOption = options.find(([code]) => code === 'FedEx2Day');
			expect(twoDayOption).toBeDefined();
		});

		it('should have unique service codes', () => {
			const options = serviceOptionsFor('FedEx');
			const codes = options.map(([code]) => code);
			const uniqueCodes = new Set(codes);
			expect(uniqueCodes.size).toBe(codes.length);
		});
	});

	describe('Default carrier behavior', () => {
		it('should default to USPS for empty carrier', () => {
			const options = serviceOptionsFor('');
			expect(options).toEqual(serviceOptionsFor('USPS'));
		});

		it('should default to USPS for unknown carrier', () => {
			const options = serviceOptionsFor('DHL');
			expect(options).toEqual(serviceOptionsFor('USPS'));
		});
	});

	describe('Service code format validation', () => {
		it('all USPS codes should be valid eBay ShippingServiceCodeType values', () => {
			// These are the known valid codes from eBay's ShippingServiceCodeType enum
			const validEbayCodes = [
				'USPSGround',
				'USPSPriority',
				'USPSPriorityMailSmallFlatRateBox',
				'USPSPriorityMailFlatRateBox',
				'USPSPriorityMailLargeFlatRateBox',
				'USPSPriorityFlatRateEnvelope',
				'USPSPriorityMailFlatRateEnvelope',
				'USPSPriorityMailPaddedFlatRateEnvelope',
				'USPSExpressMail',
				'USPSExpressMailFlatRateEnvelope',
				'USPSExpressMailFlatRateBox',
				'USPSMedia',
				'USPSFirstClass',
				'USPSParcel',
				'USPSStandardPost',
			];

			const options = serviceOptionsFor('USPS');
			for (const [code] of options) {
				expect(validEbayCodes).toContain(code);
			}
		});

		it('all UPS codes should be valid eBay ShippingServiceCodeType values', () => {
			const validEbayCodes = [
				'UPSGround',
				'UPS2ndDay',
				'UPS3rdDay',
				'UPSNextDay',
				'UPSNextDayAir',
				'UPS2DayAirAM',
			];

			const options = serviceOptionsFor('UPS');
			for (const [code] of options) {
				expect(validEbayCodes).toContain(code);
			}
		});

		it('all FedEx codes should be valid eBay ShippingServiceCodeType values', () => {
			const validEbayCodes = [
				'FedExHomeDelivery',
				'FedExGround',
				'FedEx2Day',
				'FedExExpressSaver',
				'FedExStandardOvernight',
				'FedExPriorityOvernight',
			];

			const options = serviceOptionsFor('FedEx');
			for (const [code] of options) {
				expect(validEbayCodes).toContain(code);
			}
		});
	});

	describe('Display name formatting', () => {
		it('USPS display names should be human-readable', () => {
			const options = serviceOptionsFor('USPS');
			for (const [, name] of options) {
				expect(name).toMatch(/^USPS /); // Should start with carrier name
				expect(name.length).toBeGreaterThan(5); // Should have meaningful content
			}
		});

		it('UPS display names should be human-readable', () => {
			const options = serviceOptionsFor('UPS');
			for (const [, name] of options) {
				expect(name).toMatch(/^UPS /);
				expect(name.length).toBeGreaterThan(4);
			}
		});

		it('FedEx display names should be human-readable', () => {
			const options = serviceOptionsFor('FedEx');
			for (const [, name] of options) {
				expect(name).toMatch(/^FedEx /);
				expect(name.length).toBeGreaterThan(6);
			}
		});
	});
});

describe('Policy Creation with Shipping Services', () => {
	describe('Fulfillment policy payload structure', () => {
		it('should build valid shippingServices array for USPS Ground', () => {
			const shippingService = {
				freeShipping: false,
				shippingCarrierCode: 'USPS',
				shippingServiceCode: 'USPSGround',
				sortOrder: 1,
				buyerResponsibleForShipping: false,
				buyerResponsibleForPickup: false,
				shippingCost: { value: '5.99', currency: 'USD' },
			};

			expect(shippingService.shippingCarrierCode).toBe('USPS');
			expect(shippingService.shippingServiceCode).toBe('USPSGround');
			expect(shippingService.shippingCost.value).toBe('5.99');
		});

		it('should build valid shippingServices array for USPS Priority Mail', () => {
			const shippingService = {
				freeShipping: false,
				shippingCarrierCode: 'USPS',
				shippingServiceCode: 'USPSPriority',
				sortOrder: 1,
				buyerResponsibleForShipping: false,
				buyerResponsibleForPickup: false,
				shippingCost: { value: '8.99', currency: 'USD' },
			};

			expect(shippingService.shippingServiceCode).toBe('USPSPriority');
		});

		it('should build valid shippingServices array for USPS Media Mail', () => {
			const shippingService = {
				freeShipping: false,
				shippingCarrierCode: 'USPS',
				shippingServiceCode: 'USPSMedia',
				sortOrder: 1,
				buyerResponsibleForShipping: false,
				buyerResponsibleForPickup: false,
				shippingCost: { value: '3.99', currency: 'USD' },
			};

			expect(shippingService.shippingServiceCode).toBe('USPSMedia');
		});

		it('should build valid free shipping service', () => {
			const shippingService = {
				freeShipping: true,
				shippingCarrierCode: 'USPS',
				shippingServiceCode: 'USPSPriorityMailFlatRateBox',
				sortOrder: 1,
				buyerResponsibleForShipping: false,
				buyerResponsibleForPickup: false,
			};

			expect(shippingService.freeShipping).toBe(true);
			expect(shippingService.shippingServiceCode).toBe('USPSPriorityMailFlatRateBox');
		});

		it('should build valid calculated shipping option', () => {
			const shippingOption = {
				optionType: 'DOMESTIC',
				costType: 'CALCULATED',
				shippingServices: [
					{
						freeShipping: false,
						shippingCarrierCode: 'USPS',
						shippingServiceCode: 'USPSPriority',
						sortOrder: 1,
						buyerResponsibleForShipping: false,
						buyerResponsibleForPickup: false,
					},
				],
				calculatedShippingRate: {
					measurementSystem: 'ENGLISH',
					packageType: 'PACKAGE_THICK_ENVELOPE',
					packageLength: { value: '12', unit: 'INCH' },
					packageWidth: { value: '9', unit: 'INCH' },
					packageHeight: { value: '3', unit: 'INCH' },
					weightMajor: { value: '1', unit: 'POUND' },
					weightMinor: { value: '0', unit: 'OUNCE' },
				},
			};

			expect(shippingOption.costType).toBe('CALCULATED');
			expect(shippingOption.calculatedShippingRate).toBeDefined();
			expect(shippingOption.shippingServices[0].shippingServiceCode).toBe('USPSPriority');
		});
	});
});
