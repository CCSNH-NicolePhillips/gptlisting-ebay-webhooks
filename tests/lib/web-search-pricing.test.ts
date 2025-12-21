/**
 * Unit tests for web-search-pricing.ts
 * Tests Perplexity AI integration for finding brand product pages
 */

import { searchWebForPrice } from '../../src/lib/web-search-pricing';

// Mock Perplexity client
jest.mock('../../src/lib/perplexity', () => ({
  perplexity: {
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  },
  PERPLEXITY_MODELS: {
    FAST: 'sonar',
    REASONING: 'sonar-reasoning',
  },
}));

import { perplexity } from '../../src/lib/perplexity';

describe('searchWebForPrice', () => {
  const mockCreate = perplexity.chat.completions.create as jest.MockedFunction<typeof perplexity.chat.completions.create>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PERPLEXITY_API_KEY;
  });

  describe('when API key is not set', () => {
    it('should return not-found result without calling API', async () => {
      const result = await searchWebForPrice('TestBrand', 'Test Product');

      expect(result).toEqual({
        price: null,
        url: null,
        source: 'not-found',
        confidence: 'low',
        reasoning: 'Web search disabled (no API key)',
        raw: '',
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('when API key is set', () => {
    beforeEach(() => {
      process.env.PERPLEXITY_API_KEY = 'test-key';
    });

    it('should find official brand website with price', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                price: 59.99,
                url: 'https://thebetteralt.com/products/testo-pro-capsules',
                source: 'brand-website',
                confidence: 'high',
                reasoning: 'Found on official brand site',
              }),
            },
          },
        ],
      } as any);

      const result = await searchWebForPrice('BetterAlt', 'TESTO PRO 90 capsules');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'sonar',
          temperature: 0.1,
          max_tokens: 500,
        })
      );

      expect(result).toEqual({
        price: 59.99,
        url: 'https://thebetteralt.com/products/testo-pro-capsules',
        brandDomain: null,
        source: 'brand-website',
        confidence: 'high',
        reasoning: 'Found on official brand site',
        raw: expect.stringContaining('brand-website'),
      });
    });

    it('should handle retailer URLs', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                price: 64.99,
                url: 'https://betterhealthmarket.com/product',
                source: 'retailer',
                confidence: 'medium',
                reasoning: 'Found on third-party retailer',
              }),
            },
          },
        ],
      } as any);

      const result = await searchWebForPrice('BetterAlt', 'TESTO PRO');

      expect(result.source).toBe('retailer');
      expect(result.price).toBe(64.99);
    });

    it('should handle no price found', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                price: null,
                url: '',
                source: 'not-found',
                confidence: 'low',
                reasoning: 'Product not found on any website',
              }),
            },
          },
        ],
      } as any);

      const result = await searchWebForPrice('UnknownBrand', 'Unknown Product');

      expect(result.price).toBeNull();
      expect(result.source).toBe('not-found');
    });

    it('should handle malformed JSON response', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Sorry, I cannot find that product.',
            },
          },
        ],
      } as any);

      const result = await searchWebForPrice('TestBrand', 'Test Product');

      expect(result.price).toBeNull();
      expect(result.source).toBe('not-found');
      expect(result.confidence).toBe('low');
    });

    it('should handle API errors gracefully', async () => {
      mockCreate.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await searchWebForPrice('TestBrand', 'Test Product');

      expect(result.price).toBeNull();
      expect(result.source).toBe('not-found');
      expect(result.reasoning).toContain('failed');
    });

    it('should include additional context in query', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                price: 39.99,
                url: 'https://example.com/product',
                source: 'brand-website',
                confidence: 'high',
                reasoning: 'Found',
              }),
            },
          },
        ],
      } as any);

      await searchWebForPrice(
        'Natural Stacks',
        'Dopamine Brain Food',
        'Health & Personal Care | 60 capsules'
      );

      const callArgs = mockCreate.mock.calls[0][0];
      const userMessage = callArgs.messages[0].content as string;

      expect(userMessage).toContain('Natural Stacks');
      expect(userMessage).toContain('Dopamine Brain Food');
      expect(userMessage).toContain('Health & Personal Care');
    });

    it('should extract price from URL with trailing slash', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                price: 59.99,
                url: 'https://example.com/products/test/',
                source: 'brand-website',
                confidence: 'high',
                reasoning: 'Found',
              }),
            },
          },
        ],
      } as any);

      const result = await searchWebForPrice('Brand', 'Product');

      expect(result.url).toBe('https://example.com/products/test/');
    });

    it('should handle response with extra whitespace', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: `
                {
                  "price": 49.99,
                  "url": "https://example.com/product",
                  "source": "brand-website",
                  "confidence": "high",
                  "reasoning": "Found"
                }
              `,
            },
          },
        ],
      } as any);

      const result = await searchWebForPrice('Brand', 'Product');

      expect(result.price).toBe(49.99);
      expect(result.url).toBe('https://example.com/product');
    });

    it('should handle partial JSON with missing fields', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                price: 29.99,
                url: 'https://example.com',
                // Missing source, confidence, reasoning
              }),
            },
          },
        ],
      } as any);

      const result = await searchWebForPrice('Brand', 'Product');

      expect(result.price).toBe(29.99);
      expect(result.url).toBe('https://example.com');
      // Should have defaults for missing fields
      expect(result.source).toBeDefined();
      expect(result.confidence).toBeDefined();
    });
  });

  describe('prompt construction', () => {
    beforeEach(() => {
      process.env.PERPLEXITY_API_KEY = 'test-key';
    });

    it('should ask for official brand website', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                price: null,
                url: '',
                source: 'not-found',
                confidence: 'low',
                reasoning: 'Not found',
              }),
            },
          },
        ],
      } as any);

      await searchWebForPrice('TestBrand', 'TestProduct');

      const callArgs = mockCreate.mock.calls[0][0];
      const prompt = callArgs.messages[0].content as string;

      expect(prompt).toContain('OFFICIAL BRAND WEBSITE');
      expect(prompt).toContain('brand domain');
    });

    it('should request JSON response format', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: '{}',
            },
          },
        ],
      } as any);

      await searchWebForPrice('TestBrand', 'TestProduct');

      const callArgs = mockCreate.mock.calls[0][0];
      const prompt = callArgs.messages[0].content as string;

      expect(prompt).toContain('Respond in JSON format');
      expect(prompt).toContain('"price"');
      expect(prompt).toContain('"url"');
      expect(prompt).toContain('"source"');
      expect(prompt).toContain('"confidence"');
    });
  });
});
