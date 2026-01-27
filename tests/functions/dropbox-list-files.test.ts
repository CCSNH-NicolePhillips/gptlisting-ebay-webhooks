/**
 * Tests for dropbox-list-files function
 * Validates fetching file list from a Dropbox folder
 */

import { handler } from '../../netlify/functions/dropbox-list-files.js';
import type { HandlerEvent } from '@netlify/functions';

// Mock dependencies
jest.mock('../../src/lib/redis-store.js', () => ({
	tokensStore: jest.fn(),
}));

jest.mock('../../src/lib/_auth.js', () => ({
	getBearerToken: jest.fn(),
	getJwtSubUnverified: jest.fn(),
	userScopedKey: jest.fn((sub: string, file: string) => `users/${sub}/${file}`),
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('dropbox-list-files', () => {
	let mockStore: any;
	let mockGet: jest.Mock;
	let mockGetBearerToken: jest.Mock;
	let mockGetJwtSubUnverified: jest.Mock;
	let mockUserScopedKey: jest.Mock;
	let mockFetch: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();

		// Setup mock store
		mockGet = jest.fn();
		mockStore = { get: mockGet };

		const { tokensStore } = require('../../src/lib/redis-store.js');
		tokensStore.mockReturnValue(mockStore);

		const auth = require('../../src/lib/_auth.js');
		mockGetBearerToken = auth.getBearerToken;
		mockGetJwtSubUnverified = auth.getJwtSubUnverified;
		mockUserScopedKey = auth.userScopedKey;

		mockGetBearerToken.mockReturnValue('mock-bearer-token');
		mockGetJwtSubUnverified.mockReturnValue('user-123');
		mockUserScopedKey.mockImplementation((sub: string, file: string) => `users/${sub}/${file}`);

		mockFetch = global.fetch as jest.Mock;
	});

	describe('Authentication', () => {
		it('1) returns 401 when no bearer token provided', async () => {
			mockGetBearerToken.mockReturnValue(null);

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(401);
			expect(typedResult.body).toBe('Unauthorized');
		});

		it('2) returns 401 when no JWT sub found', async () => {
			mockGetJwtSubUnverified.mockReturnValue(null);

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(401);
			expect(typedResult.body).toBe('Unauthorized');
		});

		it('3) returns 400 when no Dropbox refresh token stored', async () => {
			mockGet.mockResolvedValue(null);

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(400);
			expect(typedResult.body).toBe('Connect Dropbox first');
		});
	});

	describe('Token Exchange', () => {
		it('4) exchanges refresh token for access token', async () => {
			mockGet.mockResolvedValue({ refresh_token: 'mock-refresh-token' });
			
			// Mock token exchange
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ access_token: 'mock-access-token' }),
			});
			
			// Mock list_folder call
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ entries: [] }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			await handler(event as HandlerEvent, {} as any);

			// Verify token exchange call
			expect(mockFetch).toHaveBeenCalledWith(
				'https://api.dropboxapi.com/oauth2/token',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				})
			);
		});

		it('5) handles token exchange failure', async () => {
			mockGet.mockResolvedValue({ refresh_token: 'mock-refresh-token' });
			
			// Mock failed token exchange
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 400,
				json: async () => ({ error: 'invalid_grant' }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(500);
			const body = JSON.parse(typedResult.body || '{}');
			expect(body.error).toContain('dbx token');
		});
	});

	describe('File Listing', () => {
		beforeEach(() => {
			mockGet.mockResolvedValue({ refresh_token: 'mock-refresh-token' });
			
			// Mock successful token exchange
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ access_token: 'mock-access-token' }),
			});
		});

		it('6) lists files from specified folder', async () => {
			const mockFiles = [
				{ '.tag': 'file', name: 'image1.jpg', path_lower: '/test-folder/image1.jpg' },
				{ '.tag': 'file', name: 'image2.png', path_lower: '/test-folder/image2.png' },
			];

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ entries: mockFiles }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(200);
			const body = JSON.parse(typedResult.body || '{}');
			expect(body.ok).toBe(true);
			expect(body.files).toHaveLength(2);
			expect(body.count).toBe(2);
			expect(body.path).toBe('/test-folder');
		});

		it('7) filters out folders and returns only files', async () => {
			const mockEntries = [
				{ '.tag': 'file', name: 'image1.jpg', path_lower: '/test-folder/image1.jpg' },
				{ '.tag': 'folder', name: 'subfolder', path_lower: '/test-folder/subfolder' },
				{ '.tag': 'file', name: 'image2.png', path_lower: '/test-folder/image2.png' },
				{ '.tag': 'folder', name: 'another-folder', path_lower: '/test-folder/another-folder' },
			];

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ entries: mockEntries }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(200);
			const body = JSON.parse(typedResult.body || '{}');
			expect(body.files).toHaveLength(2);
			expect(body.files.every((f: any) => f['.tag'] === 'file')).toBe(true);
		});

		it('8) handles empty folder', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ entries: [] }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/empty-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(200);
			const body = JSON.parse(typedResult.body || '{}');
			expect(body.files).toHaveLength(0);
			expect(body.count).toBe(0);
		});

		it('9) uses empty string path when no path parameter provided', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ entries: [] }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: {},
				headers: {},
			};

			await handler(event as HandlerEvent, {} as any);

			// Verify list_folder call used empty path (root)
			expect(mockFetch).toHaveBeenCalledWith(
				'https://api.dropboxapi.com/2/files/list_folder',
				expect.objectContaining({
					body: JSON.stringify({ path: '', recursive: false }),
				})
			);
		});

		it('10) passes recursive:false to Dropbox API', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ entries: [] }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			await handler(event as HandlerEvent, {} as any);

			// Verify non-recursive listing
			expect(mockFetch).toHaveBeenCalledWith(
				'https://api.dropboxapi.com/2/files/list_folder',
				expect.objectContaining({
					body: JSON.stringify({ path: '/test-folder', recursive: false }),
				})
			);
		});
	});

	describe('Error Handling', () => {
		beforeEach(() => {
			mockGet.mockResolvedValue({ refresh_token: 'mock-refresh-token' });
			
			// Mock successful token exchange
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ access_token: 'mock-access-token' }),
			});
		});

		it('11) handles Dropbox API errors', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 409,
				json: async () => ({ error: { '.tag': 'path/not_found' } }),
			});

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/nonexistent' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(409);
			const body = JSON.parse(typedResult.body || '{}');
			expect(body.error).toBeDefined();
		});

		it('12) handles network errors gracefully', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			const event: Partial<HandlerEvent> = {
				queryStringParameters: { path: '/test-folder' },
				headers: {},
			};

			const result = await handler(event as HandlerEvent, {} as any);
			if (!result) throw new Error('No response');
			const typedResult = result as import('@netlify/functions').HandlerResponse;

			expect(typedResult.statusCode).toBe(500);
			const body = JSON.parse(typedResult.body || '{}');
			expect(body.error).toContain('Network error');
		});
	});
});
