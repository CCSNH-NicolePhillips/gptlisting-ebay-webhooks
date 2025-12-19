/**
 * Unit tests for policy defaults persistence
 * Tests ebay-create-policy, ebay-set-policy-defaults, and ebay-get-policy-defaults
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { HandlerEvent } from '@netlify/functions';

// Mock dependencies
jest.mock('../../src/lib/_blobs.js', () => ({
	tokensStore: jest.fn(() => ({
		get: jest.fn(),
		set: jest.fn(),
	})),
}));

jest.mock('../../src/lib/_auth.js', () => ({
	json: jest.fn((data: any, status?: number) => ({
		statusCode: status || 200,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})),
	getBearerToken: jest.fn(() => 'mock-bearer-token'),
	getJwtSubUnverified: jest.fn(() => 'user123'),
	requireAuthVerified: jest.fn(async () => ({ sub: 'user123' })),
	userScopedKey: jest.fn((sub: string, key: string) => `user:${sub}:${key}`),
}));

jest.mock('../../src/lib/_ebay.js', () => ({
	getUserAccessToken: jest.fn(async () => 'mock-access-token'),
	apiHost: jest.fn(() => 'https://api.ebay.com'),
	headers: jest.fn(() => ({
		'Authorization': 'Bearer mock-access-token',
		'Content-Type': 'application/json',
		'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
	})),
}));

// Import after mocks
import { tokensStore } from '../../src/lib/_blobs.js';
import { userScopedKey } from '../../src/lib/_auth.js';

describe('Policy Defaults Persistence', () => {
	let mockStore: any;

	beforeEach(() => {
		jest.clearAllMocks();
		mockStore = {
			get: jest.fn(),
			set: jest.fn(),
		};
		(tokensStore as jest.Mock).mockReturnValue(mockStore);
		
		// Mock fetch for eBay API calls
		global.fetch = jest.fn() as any;
	});

	describe('ebay-set-policy-defaults', () => {
		it('should set fulfillment policy default', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ fulfillment: 'policy-123' }),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			expect(mockStore.set).toHaveBeenCalledWith(
				'user:user123:policy-defaults.json',
				JSON.stringify({ fulfillment: 'policy-123' })
			);

			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults.fulfillment).toBe('policy-123');
		});

		it('should set payment policy default', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ payment: 'payment-456' }),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			expect(mockStore.set).toHaveBeenCalledWith(
				'user:user123:policy-defaults.json',
				JSON.stringify({ payment: 'payment-456' })
			);

			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults.payment).toBe('payment-456');
		});

		it('should set return policy default', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ return: 'return-789' }),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			expect(mockStore.set).toHaveBeenCalledWith(
				'user:user123:policy-defaults.json',
				JSON.stringify({ return: 'return-789' })
			);

			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults.return).toBe('return-789');
		});

		it('should update existing defaults without clearing other types', async () => {
			mockStore.get.mockResolvedValue({
				fulfillment: 'existing-fulfillment',
				payment: 'existing-payment',
			});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ return: 'new-return' }),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			expect(mockStore.set).toHaveBeenCalledWith(
				'user:user123:policy-defaults.json',
				JSON.stringify({
					fulfillment: 'existing-fulfillment',
					payment: 'existing-payment',
					return: 'new-return',
				})
			);
		});

		it('should handle blob storage read failures gracefully', async () => {
			mockStore.get.mockRejectedValue(new Error('Blob read failed'));
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ fulfillment: 'policy-123' }),
			};

			const response = await handler(event as HandlerEvent, {} as any);

			// Should still succeed by creating new defaults object
			expect(typedResponse.statusCode).toBe(200);
			expect(mockStore.set).toHaveBeenCalledWith(
				'user:user123:policy-defaults.json',
				JSON.stringify({ fulfillment: 'policy-123' })
			);
		});

		it('should clean empty string values', async () => {
			mockStore.get.mockResolvedValue({ fulfillment: 'existing' });
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ payment: '' }),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.defaults.payment).toBeUndefined();
			expect(body.defaults.fulfillment).toBe('existing');
		});

		it('should set promoCampaignId default', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ promoCampaignId: 'campaign-123' }),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.defaults.promoCampaignId).toBe('campaign-123');
		});

		it('should clear promoCampaignId when set to null', async () => {
			mockStore.get.mockResolvedValue({ promoCampaignId: 'existing-campaign' });
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-set-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({ promoCampaignId: null }),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.defaults.promoCampaignId).toBeUndefined();
		});
	});

	describe('ebay-get-policy-defaults', () => {
		it('should retrieve stored defaults', async () => {
			mockStore.get.mockResolvedValue({
				fulfillment: 'fulfillment-123',
				payment: 'payment-456',
				return: 'return-789',
			} as any);

			const { handler } = await import('../../netlify/functions/ebay-get-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults).toEqual({
				fulfillment: 'fulfillment-123',
				payment: 'payment-456',
				return: 'return-789',
			});
		});

		it('should return empty defaults when none exist', async () => {
			mockStore.get.mockRejectedValue(new Error('Not found'));

			const { handler } = await import('../../netlify/functions/ebay-get-policy-defaults.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults).toEqual({});
		});

		it('should handle unauthorized requests', async () => {
			const { handler } = await import('../../netlify/functions/ebay-get-policy-defaults.js');
			const getBearerToken = (await import('../../src/lib/_auth.js')).getBearerToken as jest.Mock;
			getBearerToken.mockReturnValueOnce(null);

			const event: Partial<HandlerEvent> = {
				headers: {},
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(401);
		});
	});

	describe('ebay-create-policy with setDefault', () => {
		beforeEach(() => {
			// Mock successful eBay API response
			(global.fetch as jest.Mock).mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				text: async () => JSON.stringify({
					fulfillmentPolicyId: 'new-policy-123',
					name: 'Test Policy',
				}),
			} as any);
		});

		it('should set fulfillment policy as default when creating with setDefault=true', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-create-policy.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({
					type: 'fulfillment',
					name: 'Test Fulfillment Policy',
					setDefault: true,
					handlingTimeDays: 1,
					freeDomestic: true,
				}),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults).toBeDefined();
			expect(body.defaults.fulfillment).toBe('new-policy-123');

			// Verify blob storage was updated
			expect(mockStore.set).toHaveBeenCalledWith(
				'user:user123:policy-defaults.json',
				expect.stringContaining('new-policy-123')
			);
		});

		it('should set payment policy as default when creating with setDefault=true', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			(global.fetch as jest.Mock).mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				text: async () => JSON.stringify({
					paymentPolicyId: 'payment-policy-456',
					name: 'Test Payment Policy',
				}),
			} as any);

			const { handler } = await import('../../netlify/functions/ebay-create-policy.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({
					type: 'payment',
					name: 'Test Payment Policy',
					setDefault: true,
					immediatePay: false,
				}),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults.payment).toBe('payment-policy-456');
		});

		it('should set return policy as default when creating with setDefault=true', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			(global.fetch as jest.Mock).mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Map(),
				text: async () => JSON.stringify({
					returnPolicyId: 'return-policy-789',
					name: 'Test Return Policy',
				}),
			} as any);

			const { handler } = await import('../../netlify/functions/ebay-create-policy.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({
					type: 'return',
					name: 'Test Return Policy',
					setDefault: true,
					returnsAccepted: true,
					returnPeriodDays: 30,
				}),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults.return).toBe('return-policy-789');
		});

		it('should not set default when setDefault=false', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-create-policy.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({
					type: 'fulfillment',
					name: 'Test Policy',
					setDefault: false,
					handlingTimeDays: 1,
					freeDomestic: true,
				}),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.defaults).toBeNull();

			// Verify blob storage was NOT updated
			expect(mockStore.set).not.toHaveBeenCalled();
		});

		it('should preserve other policy defaults when setting one type', async () => {
			mockStore.get.mockResolvedValue({
				payment: 'existing-payment',
				return: 'existing-return',
			});
			mockStore.set.mockResolvedValue(undefined);

			const { handler } = await import('../../netlify/functions/ebay-create-policy.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({
					type: 'fulfillment',
					name: 'New Fulfillment',
					setDefault: true,
					handlingTimeDays: 1,
					freeDomestic: true,
				}),
			};

			const response = await handler(event as HandlerEvent, {} as any);
			if (!response) throw new Error('No response');
			const typedResponse = response as import('@netlify/functions').HandlerResponse;

			expect(typedResponse.statusCode).toBe(200);
			const setCall = mockStore.set.mock.calls[0];
			const savedData = JSON.parse(setCall[1]);
			expect(savedData).toEqual({
				payment: 'existing-payment',
				return: 'existing-return',
				fulfillment: 'new-policy-123',
			});
		});

		it('should handle blob storage write failures without crashing', async () => {
			mockStore.get.mockResolvedValue({});
			mockStore.set.mockRejectedValue(new Error('Blob write failed'));

			const { handler } = await import('../../netlify/functions/ebay-create-policy.js');

			const event: Partial<HandlerEvent> = {
				headers: { authorization: 'Bearer mock-token' },
				body: JSON.stringify({
					type: 'fulfillment',
					name: 'Test Policy',
					setDefault: true,
					handlingTimeDays: 1,
					freeDomestic: true,
				}),
			};

			const response = await handler(event as HandlerEvent, {} as any);

			// Should still succeed - policy was created on eBay
			expect(typedResponse.statusCode).toBe(200);
			const body = JSON.parse(typedResponse.body);
			expect(body.ok).toBe(true);
			expect(body.id).toBe('new-policy-123');
			// defaults will be null due to storage failure
		});
	});
});
