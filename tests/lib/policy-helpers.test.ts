/**
 * Unit tests for policy-helpers.ts free shipping detection
 */

import { describe, it, expect } from '@jest/globals';
import { hasFreeShipping, extractShippingCost } from '../../src/lib/policy-helpers.js';

describe('Policy Helpers', () => {
	describe('hasFreeShipping', () => {
		it('should return true when policy has free domestic shipping', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						shippingServices: [
							{
								freeShipping: true,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSPriorityFlatRateBox',
							},
						],
					},
				],
			};

			expect(hasFreeShipping(policy)).toBe(true);
		});

		it('should return false when policy has paid shipping', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: '6.00', currency: 'USD' },
							},
						],
					},
				],
			};

			expect(hasFreeShipping(policy)).toBe(false);
		});

		it('should return false when policy has calculated shipping', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'CALCULATED',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
							},
						],
						calculatedShippingRate: {
							packageType: 'PACKAGE_THICK_ENVELOPE',
							packageLength: { value: '12', unit: 'INCH' },
							packageWidth: { value: '9', unit: 'INCH' },
							packageHeight: { value: '3', unit: 'INCH' },
							weightMajor: { value: '1', unit: 'POUND' },
							weightMinor: { value: '0', unit: 'OUNCE' },
						},
					},
				],
			};

			expect(hasFreeShipping(policy)).toBe(false);
		});

		it('should return true if ANY service has free shipping', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSPriority',
								shippingCost: { value: '8.00', currency: 'USD' },
							},
							{
								freeShipping: true,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSMedia',
							},
						],
					},
				],
			};

			expect(hasFreeShipping(policy)).toBe(true);
		});

		it('should ignore INTERNATIONAL shipping options', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'INTERNATIONAL',
						shippingServices: [
							{
								freeShipping: true,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSFirstClassMailInternational',
							},
						],
					},
					{
						optionType: 'DOMESTIC',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: '5.00', currency: 'USD' },
							},
						],
					},
				],
			};

			expect(hasFreeShipping(policy)).toBe(false);
		});

		it('should return false for invalid policy object', () => {
			expect(hasFreeShipping(null)).toBe(false);
			expect(hasFreeShipping(undefined)).toBe(false);
			expect(hasFreeShipping({})).toBe(false);
			expect(hasFreeShipping({ shippingOptions: null })).toBe(false);
			expect(hasFreeShipping({ shippingOptions: [] })).toBe(false);
		});

		it('should return false when shippingServices is missing', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
					},
				],
			};

			expect(hasFreeShipping(policy)).toBe(false);
		});
	});

	describe('extractShippingCost', () => {
		it('should extract flat rate shipping cost in cents', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: '6.00', currency: 'USD' },
							},
						],
					},
				],
			};

			expect(extractShippingCost(policy)).toBe(600);
		});

		it('should return 0 for free shipping', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: true,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSPriorityFlatRateBox',
							},
						],
					},
				],
			};

			expect(extractShippingCost(policy)).toBe(0);
		});

		it('should return null for calculated shipping', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'CALCULATED',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
							},
						],
						calculatedShippingRate: {
							packageType: 'PACKAGE_THICK_ENVELOPE',
						},
					},
				],
			};

			expect(extractShippingCost(policy)).toBeNull();
		});

		it('should round shipping cost to nearest cent', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: '5.99', currency: 'USD' },
							},
						],
					},
				],
			};

			expect(extractShippingCost(policy)).toBe(599);
		});

		it('should use the first service when multiple services exist', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: '5.00', currency: 'USD' },
							},
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSPriority',
								shippingCost: { value: '8.00', currency: 'USD' },
							},
						],
					},
				],
			};

			expect(extractShippingCost(policy)).toBe(500);
		});

		it('should return null for invalid policy object', () => {
			expect(extractShippingCost(null)).toBeNull();
			expect(extractShippingCost(undefined)).toBeNull();
			expect(extractShippingCost({})).toBeNull();
			expect(extractShippingCost({ shippingOptions: null })).toBeNull();
			expect(extractShippingCost({ shippingOptions: [] })).toBeNull();
		});

		it('should return null when cost value is invalid', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: 'invalid', currency: 'USD' },
							},
						],
					},
				],
			};

			expect(extractShippingCost(policy)).toBeNull();
		});

		it('should handle negative shipping cost (treat as 0)', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: '-5.00', currency: 'USD' },
							},
						],
					},
				],
			};

			// Negative costs should be filtered out
			expect(extractShippingCost(policy)).toBeNull();
		});

		it('should skip INTERNATIONAL shipping options', () => {
			const policy = {
				shippingOptions: [
					{
						optionType: 'INTERNATIONAL',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSFirstClassMailInternational',
								shippingCost: { value: '15.00', currency: 'USD' },
							},
						],
					},
					{
						optionType: 'DOMESTIC',
						costType: 'FLAT_RATE',
						shippingServices: [
							{
								freeShipping: false,
								shippingCarrierCode: 'USPS',
								shippingServiceCode: 'USPSParcel',
								shippingCost: { value: '6.00', currency: 'USD' },
							},
						],
					},
				],
			};

			expect(extractShippingCost(policy)).toBe(600);
		});
	});
});
