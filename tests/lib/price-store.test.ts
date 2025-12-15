// Mock environment variables before imports
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-123';

import fetch from 'node-fetch';
import {
  bindListing,
  getListingBinding,
  getBindingsForJob,
  listAllBindings,
  updateBinding,
  removeBinding,
  getAllPriceKeys,
  getPriceState,
} from '../../src/lib/price-store.js';

// Mock node-fetch
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

describe('price-store', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe('bindListing', () => {
    describe('Basic functionality', () => {
      it('should create new binding', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: null }),
          } as any) // GET (existing check)
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 'OK' }),
          } as any) // SETEX
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any) // SADD job index
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any) // EXPIRE job index
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any) // SADD global index
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any); // EXPIRE global index

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 29.99,
        });

        expect(result.jobId).toBe('job1');
        expect(result.groupId).toBe('group1');
        expect(result.userId).toBe('user1');
        expect(result.currentPrice).toBe(29.99);
        expect(result.offerId).toBeNull();
        expect(result.listingId).toBeNull();
      });

      it('should update existing binding', async () => {
        const existing = {
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          offerId: 'offer123',
          listingId: null,
          sku: null,
          currentPrice: 29.99,
          pricing: null,
          auto: null,
          metadata: null,
          createdAt: Date.now() - 1000,
          updatedAt: Date.now() - 1000,
          lastReductionAt: null,
          lastTickAt: null,
          lastTick: null,
        };

        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: JSON.stringify(existing) }),
          } as any) // GET (existing)
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 'OK' }),
          } as any) // SETEX
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any) // SADD job index
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any) // EXPIRE job index
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any) // SADD global index
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 }),
          } as any); // EXPIRE global index

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 34.99,
        });

        expect(result.currentPrice).toBe(34.99);
        expect(result.offerId).toBe('offer123');
        expect(result.updatedAt).toBeGreaterThan(existing.updatedAt);
      });

      it('should handle pricing snapshot', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: null }),
          } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          pricing: { base: 49.99, ebay: 44.99 },
        });

        expect(result.pricing).toEqual({ base: 49.99, ebay: 44.99 });
        expect(result.currentPrice).toBe(44.99);
      });

      it('should handle auto config', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: null }),
          } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 29.99,
          auto: { reduceBy: 2.5, everyDays: 7, minPrice: 19.99 },
        });

        expect(result.auto).toEqual({ reduceBy: 2.5, everyDays: 7, minPrice: 19.99 });
      });

      it('should handle metadata', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: null }),
          } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 29.99,
          metadata: { title: 'Test Product', brand: 'TestBrand' },
        });

        expect(result.metadata).toEqual({ title: 'Test Product', brand: 'TestBrand' });
      });

      it('should throw error for missing jobId', async () => {
        await expect(
          bindListing({
            jobId: '',
            groupId: 'group1',
            userId: 'user1',
          })
        ).rejects.toThrow('Missing jobId, groupId, or userId');
      });

      it('should throw error for missing groupId', async () => {
        await expect(
          bindListing({
            jobId: 'job1',
            groupId: '',
            userId: 'user1',
          })
        ).rejects.toThrow('Missing jobId, groupId, or userId');
      });

      it('should throw error for missing userId', async () => {
        await expect(
          bindListing({
            jobId: 'job1',
            groupId: 'group1',
            userId: '',
          })
        ).rejects.toThrow('Missing jobId, groupId, or userId');
      });
    });

    describe('Price sanitization', () => {
      it('should round prices to 2 decimals', async () => {
        mockFetch
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 29.999,
        });

        expect(result.currentPrice).toBe(30);
      });

      it('should handle negative prices', async () => {
        mockFetch
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: -10,
        });

        expect(result.currentPrice).toBe(0);
      });

      it('should handle non-numeric prices', async () => {
        mockFetch
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 'invalid' as any,
        });

        expect(result.currentPrice).toBe(0);
      });
    });

    describe('Auto config validation', () => {
      it('should reject auto config with reduceBy <= 0', async () => {
        mockFetch
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 29.99,
          auto: { reduceBy: 0, everyDays: 7, minPrice: 19.99 },
        });

        expect(result.auto).toBeNull();
      });

      it('should clamp everyDays of 0 to 1', async () => {
        mockFetch
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 29.99,
          auto: { reduceBy: 2.5, everyDays: 0, minPrice: 19.99 },
        });

        expect(result.auto).toEqual({ reduceBy: 2.5, everyDays: 1, minPrice: 19.99 });
      });

      it('should enforce minimum everyDays of 1', async () => {
        mockFetch
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

        const result = await bindListing({
          jobId: 'job1',
          groupId: 'group1',
          userId: 'user1',
          currentPrice: 29.99,
          auto: { reduceBy: 2.5, everyDays: 0.5, minPrice: 19.99 },
        });

        expect(result.auto).toEqual({ reduceBy: 2.5, everyDays: 1, minPrice: 19.99 });
      });
    });
  });

  describe('getListingBinding', () => {
    it('should return binding if exists', async () => {
      const binding = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(binding) }),
      } as any);

      const result = await getListingBinding('job1', 'group1');

      expect(result).toMatchObject({
        jobId: 'job1',
        groupId: 'group1',
        currentPrice: 29.99,
      });
    });

    it('should return null if not exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const result = await getListingBinding('job1', 'group1');

      expect(result).toBeNull();
    });

    it('should handle malformed JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'invalid-json{' }),
      } as any);

      const result = await getListingBinding('job1', 'group1');

      expect(result).toBeNull();
    });

    it('should handle missing required fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ jobId: 'job1' }), // missing groupId, userId
        }),
      } as any);

      const result = await getListingBinding('job1', 'group1');

      expect(result).toBeNull();
    });
  });

  describe('getBindingsForJob', () => {
    it('should return all bindings for job', async () => {
      const binding1 = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };
      const binding2 = {
        ...binding1,
        groupId: 'group2',
        currentPrice: 34.99,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: ['price:binding:job1:group1', 'price:binding:job1:group2'],
          }),
        } as any) // SMEMBERS
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: [JSON.stringify(binding1), JSON.stringify(binding2)],
          }),
        } as any); // MGET

      const result = await getBindingsForJob('job1');

      expect(result).toHaveLength(2);
      expect(result[0].groupId).toBe('group1');
      expect(result[1].groupId).toBe('group2');
    });

    it('should return empty array if no bindings', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      } as any);

      const result = await getBindingsForJob('job1');

      expect(result).toEqual([]);
    });

    it('should skip invalid bindings and cleanup', async () => {
      const valid = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: ['price:binding:job1:group1', 'price:binding:job1:group2'],
          }),
        } as any) // SMEMBERS
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: [JSON.stringify(valid), 'invalid-json{'],
          }),
        } as any) // MGET
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any) // SREM global
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any); // SREM job

      const result = await getBindingsForJob('job1');

      expect(result).toHaveLength(1);
      expect(result[0].groupId).toBe('group1');
    });

    it('should sort by updatedAt descending', async () => {
      const old = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 2000,
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };
      const recent = {
        ...old,
        groupId: 'group2',
        updatedAt: Date.now(),
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: ['price:binding:job1:group1', 'price:binding:job1:group2'],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: [JSON.stringify(old), JSON.stringify(recent)],
          }),
        } as any);

      const result = await getBindingsForJob('job1');

      expect(result[0].groupId).toBe('group2'); // most recent first
      expect(result[1].groupId).toBe('group1');
    });
  });

  describe('listAllBindings', () => {
    it('should return all bindings globally', async () => {
      const binding1 = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };
      const binding2 = {
        ...binding1,
        jobId: 'job2',
        groupId: 'group1',
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: ['price:binding:job1:group1', 'price:binding:job2:group1'],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: [JSON.stringify(binding1), JSON.stringify(binding2)],
          }),
        } as any);

      const result = await listAllBindings();

      expect(result).toHaveLength(2);
      expect(result.find((b) => b.jobId === 'job1')).toBeDefined();
      expect(result.find((b) => b.jobId === 'job2')).toBeDefined();
    });

    it('should return empty array if no bindings', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      } as any);

      const result = await listAllBindings();

      expect(result).toEqual([]);
    });
  });

  describe('updateBinding', () => {
    it('should update existing binding', async () => {
      const existing = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: JSON.stringify(existing) }),
        } as any) // GET
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any) // SETEX
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any) // SADD job
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any) // EXPIRE job
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any) // SADD global
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any); // EXPIRE global

      const result = await updateBinding('job1', 'group1', {
        currentPrice: 34.99,
        listingId: 'listing123',
      });

      expect(result).not.toBeNull();
      expect(result!.currentPrice).toBe(34.99);
      expect(result!.listingId).toBe('listing123');
      expect(result!.updatedAt).toBeGreaterThan(existing.updatedAt);
    });

    it('should return null if binding not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const result = await updateBinding('job1', 'group1', { currentPrice: 34.99 });

      expect(result).toBeNull();
    });

    it('should handle metadata merge', async () => {
      const existing = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: { title: 'Old Title', brand: 'OldBrand' },
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: JSON.stringify(existing) }),
        } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

      const result = await updateBinding('job1', 'group1', {
        metadata: { title: 'New Title' },
      });

      expect(result!.metadata).toEqual({ title: 'New Title', brand: 'OldBrand' });
    });

    it('should handle lastTick update', async () => {
      const existing = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: JSON.stringify(existing) }),
        } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'OK' }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 1 }) } as any);

      const result = await updateBinding('job1', 'group1', {
        lastTick: {
          at: Date.now(),
          status: 'updated',
          fromPrice: 29.99,
          toPrice: 27.49,
        },
      });

      expect(result!.lastTick).toMatchObject({
        status: 'updated',
        fromPrice: 29.99,
        toPrice: 27.49,
      });
    });
  });

  describe('removeBinding', () => {
    it('should remove existing binding', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any) // DEL
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any) // SREM global
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any); // SREM job

      const result = await removeBinding('job1', 'group1');

      expect(result).toBe(true);
    });

    it('should return false if binding not found', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 0 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 0 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 0 }),
        } as any);

      const result = await removeBinding('job1', 'group1');

      expect(result).toBe(false);
    });
  });

  describe('getAllPriceKeys', () => {
    it('should return all keys for job prefix', async () => {
      const binding1 = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: null,
        metadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: ['price:binding:job1:group1'],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: [JSON.stringify(binding1)],
          }),
        } as any);

      const result = await getAllPriceKeys('price:job1');

      expect(result).toEqual(['price:binding:job1:group1']);
    });

    it('should return all keys globally', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: ['price:binding:job1:group1', 'price:binding:job2:group1'],
        }),
      } as any);

      const result = await getAllPriceKeys();

      expect(result).toHaveLength(2);
    });

    it('should filter keys by prefix', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: ['test:key1', 'test:key2', 'other:key'],
        }),
      } as any); // SMEMBERS global

      const result = await getAllPriceKeys('test');

      expect(result).toEqual(['test:key1', 'test:key2']);
    });
  });

  describe('getPriceState', () => {
    it('should return price state', async () => {
      const binding = {
        jobId: 'job1',
        groupId: 'group1',
        userId: 'user1',
        offerId: null,
        listingId: null,
        sku: null,
        currentPrice: 29.99,
        pricing: null,
        auto: { reduceBy: 2.5, everyDays: 7, minPrice: 19.99 },
        metadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastReductionAt: null,
        lastTickAt: null,
        lastTick: null,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(binding) }),
      } as any);

      const result = await getPriceState('price:binding:job1:group1');

      expect(result).toMatchObject({
        key: 'price:binding:job1:group1',
        current: 29.99,
        auto: { reduceBy: 2.5, everyDays: 7, minPrice: 19.99 },
      });
    });

    it('should return null for empty key', async () => {
      const result = await getPriceState('');

      expect(result).toBeNull();
    });

    it('should return null if binding not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const result = await getPriceState('price:binding:job1:group1');

      expect(result).toBeNull();
    });
  });

  describe('Error handling', () => {
    it('should handle Redis API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any);

      await expect(getListingBinding('job1', 'group1')).rejects.toThrow(
        'Redis error 500'
      );
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(getListingBinding('job1', 'group1')).rejects.toThrow('Network error');
    });
  });
});



