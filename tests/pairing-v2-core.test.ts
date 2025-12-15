/**
 * Unit tests for Pairing V2 Core
 * Tests the three-stage pipeline: Classification → Pairing → Verification
 */

// Mock OpenAI
jest.mock('../src/lib/openai', () => ({
  openai: {
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  },
}));

// Mock fs
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  mkdtempSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

import { openai } from '../src/lib/openai';
import * as fs from 'fs';
import { 
  classifyImagesBatch, 
  pairFromClassifications, 
  verifyPairs 
} from '../src/smartdrafts/pairing-v2-core';

const mockOpenAI = openai.chat.completions.create as jest.Mock;
const mockReadFile = fs.readFileSync as jest.Mock;

describe('Pairing V2 Core', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockReturnValue(Buffer.from('fake-image-data'));
  });

  describe('Stage 1: Classification', () => {
    it('should classify product images correctly', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              items: [
                {
                  filename: 'dopamine-front.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: 'Natural Stacks',
                  productName: 'Dopamine Brain Food',
                  title: null,
                  packageType: 'bottle',
                  keyText: ['Natural Stacks', 'Dopamine', 'Brain Food'],
                  colorSignature: ['white', 'orange', 'blue'],
                  layoutSignature: 'bottle with wraparound label',
                  confidence: 0.95,
                  rationale: 'Clear product label'
                },
                {
                  filename: 'dopamine-back.jpg',
                  kind: 'product',
                  panel: 'back',
                  brand: 'Natural Stacks',
                  productName: 'Dopamine Brain Food',
                  title: null,
                  packageType: 'bottle',
                  keyText: ['Supplement Facts'],
                  colorSignature: ['white', 'orange'],
                  layoutSignature: 'supplement facts panel',
                  confidence: 0.92,
                  rationale: 'Back panel'
                }
              ]
            })
          }
        }]
      };

      mockOpenAI.mockResolvedValue(mockResponse);

      const result = await classifyImagesBatch([
        '/tmp/dopamine-front.jpg',
        '/tmp/dopamine-back.jpg'
      ]);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        filename: 'dopamine-front.jpg',
        kind: 'product',
        panel: 'front',
        brand: 'Natural Stacks',
      });
    });

    it('should classify books with null brand', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'book.jpg',
                kind: 'product',
                panel: 'front',
                brand: null,
                productName: 'Bobbi Brown',
                title: 'Still Bobbi',
                packageType: 'book',
                keyText: [],
                colorSignature: [],
                layoutSignature: 'book',
                confidence: 0.98,
                rationale: 'Book'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/book.jpg']);

      expect(result[0].brand).toBeNull();
      expect(result[0].title).toBe('Still Bobbi');
      expect(result[0].packageType).toBe('book');
    });

    it('should apply hotfix for books missing title', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'book.jpg',
                kind: 'product',
                panel: 'front',
                brand: null,
                productName: 'Harry Potter',
                title: null,
                packageType: 'book',
                keyText: [],
                colorSignature: [],
                layoutSignature: 'book',
                confidence: 0.9,
                rationale: 'Book'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/book.jpg']);

      expect(result[0].title).toBe('Harry Potter');
    });

    it('should handle errors gracefully', async () => {
      mockOpenAI.mockRejectedValue(new Error('API timeout'));

      await expect(classifyImagesBatch(['/tmp/test.jpg'])).rejects.toThrow('API timeout');
    });
  });

  describe('Stage 2: Pairing', () => {
    it('should pair matching products', async () => {
      const classifications = [
        {
          filename: 'front.jpg',
          kind: 'product' as const,
          panel: 'front' as const,
          brand: 'Natural Stacks',
          productName: 'Dopamine',
          title: null,
          packageType: 'bottle' as const,
          keyText: [],
          colorSignature: [],
          layoutSignature: 'bottle',
          confidence: 0.95,
        },
        {
          filename: 'back.jpg',
          kind: 'product' as const,
          panel: 'back' as const,
          brand: 'Natural Stacks',
          productName: 'Dopamine',
          title: null,
          packageType: 'bottle' as const,
          keyText: [],
          colorSignature: [],
          layoutSignature: 'bottle',
          confidence: 0.92,
        }
      ];

      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Matching brand',
                confidence: 0.95
              }],
              unpaired: []
            })
          }
        }]
      });

      const result = await pairFromClassifications(classifications);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].front).toBe('front.jpg');
    });

    it('should pair books by title', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'book-front.jpg',
                back: 'book-back.jpg',
                reasoning: 'Matching title',
                confidence: 0.97
              }],
              unpaired: []
            })
          }
        }]
      });

      const result = await pairFromClassifications([
        {
          filename: 'book-front.jpg',
          kind: 'product',
          panel: 'front',
          brand: null,
          productName: 'Author',
          title: 'Book Title',
          packageType: 'book',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'book',
          confidence: 0.98,
        }
      ]);

      expect(result.pairs[0].front).toBe('book-front.jpg');
    });

    it('should leave mismatched brands unpaired', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [],
              unpaired: [{
                filename: 'front.jpg',
                reason: 'No match',
                needsReview: true
              }]
            })
          }
        }]
      });

      const result = await pairFromClassifications([
        {
          filename: 'front.jpg',
          kind: 'product',
          panel: 'front',
          brand: 'Jocko',
          productName: 'Fish Oil',
          title: null,
          packageType: 'bottle',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'bottle',
          confidence: 0.9,
        }
      ]);

      expect(result.pairs).toHaveLength(0);
      expect(result.unpaired).toHaveLength(1);
    });

    it('should handle errors gracefully', async () => {
      mockOpenAI.mockRejectedValue(new Error('API error'));

      const result = await pairFromClassifications([
        {
          filename: 'test.jpg',
          kind: 'product',
          panel: 'front',
          brand: 'Test',
          productName: 'Test',
          title: null,
          packageType: 'bottle',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'test',
          confidence: 0.9,
        }
      ]);

      expect(result.pairs).toEqual([]);
      expect(result.unpaired[0].reason).toBe('Pairing failed due to error');
    });
  });

  describe('Stage 3: Verification', () => {
    it('should accept valid pairs', async () => {
      const classifications = [
        {
          filename: 'front.jpg',
          kind: 'product' as const,
          panel: 'front' as const,
          brand: 'Jocko',
          productName: 'Fish Oil',
          title: null,
          packageType: 'bottle' as const,
          keyText: [],
          colorSignature: [],
          layoutSignature: 'bottle',
          confidence: 0.95,
        }
      ];

      const pairing = {
        pairs: [{
          front: 'front.jpg',
          back: 'back.jpg',
          reasoning: 'Match',
          confidence: 0.95
        }],
        unpaired: []
      };

      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Match',
                confidence: 0.95,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await verifyPairs(classifications, pairing);

      expect(result.verifiedPairs[0].status).toBe('accepted');
    });

    it('should accept books with null brand', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'book-front.jpg',
                back: 'book-back.jpg',
                reasoning: 'Title match',
                confidence: 0.97,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await verifyPairs(
        [{
          filename: 'book-front.jpg',
          kind: 'product',
          panel: 'front',
          brand: null,
          productName: 'Author',
          title: 'Book',
          packageType: 'book',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'book',
          confidence: 0.98,
        }],
        {
          pairs: [{
            front: 'book-front.jpg',
            back: 'book-back.jpg',
            reasoning: 'Match',
            confidence: 0.97
          }],
          unpaired: []
        }
      );

      expect(result.verifiedPairs[0].status).toBe('accepted');
    });

    it('should reject mismatched pairs', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Mismatch',
                confidence: 0.5,
                status: 'rejected',
                issues: ['Brand mismatch']
              }]
            })
          }
        }]
      });

      const result = await verifyPairs(
        [],
        {
          pairs: [{
            front: 'front.jpg',
            back: 'back.jpg',
            reasoning: 'Test',
            confidence: 0.5
          }],
          unpaired: []
        }
      );

      expect(result.verifiedPairs[0].status).toBe('rejected');
    });

    it('should fail open on errors', async () => {
      mockOpenAI.mockRejectedValue(new Error('API error'));

      const result = await verifyPairs(
        [],
        {
          pairs: [{
            front: 'front.jpg',
            back: 'back.jpg',
            reasoning: 'Test',
            confidence: 0.9
          }],
          unpaired: []
        }
      );

      expect(result.verifiedPairs[0].status).toBe('accepted');
    });
  });

  describe('Classification Edge Cases', () => {
    it('should handle quantityInPhoto field', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'multi.jpg',
                kind: 'product',
                panel: 'front',
                brand: 'TestBrand',
                productName: 'Test Product',
                title: null,
                packageType: 'bottle',
                keyText: [],
                colorSignature: [],
                layoutSignature: 'multiple bottles',
                confidence: 0.9,
                quantityInPhoto: 3,
                rationale: 'Three bottles visible'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/multi.jpg']);

      expect(result[0].quantityInPhoto).toBe(3);
    });

    it('should apply book hotfix when title is missing', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'book.jpg',
                kind: 'product',
                panel: 'front',
                brand: null,
                productName: 'Stephen King',
                title: null,
                packageType: 'book',
                keyText: ['The Shining'],
                colorSignature: [],
                layoutSignature: 'book cover',
                confidence: 0.95,
                rationale: 'Book with missing title'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/book.jpg']);

      expect(result[0].title).toBe('Stephen King');
      expect(result[0].productName).toBe('Stephen King');
    });

    it('should detect and correct misclassified supplements as books', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'dopamine.jpg',
                kind: 'product',
                panel: 'front',
                brand: null,
                productName: null,
                title: 'Dopamine Brain Food',
                packageType: 'book',
                keyText: ['Supports cognitive function', 'Dopamine'],
                categoryPath: 'Books > Health',
                colorSignature: ['white', 'orange'],
                layoutSignature: 'bottle label',
                confidence: 0.85,
                rationale: 'Misclassified'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/dopamine.jpg']);

      expect(result[0].packageType).toBe('bottle');
      expect(result[0].productName).toBe('Dopamine Brain Food');
      expect(result[0].title).toBeNull();
      expect(result[0].categoryPath).toContain('Dietary Supplements');
    });

    it('should handle non-product images', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'cat.jpg',
                kind: 'non_product',
                panel: 'unknown',
                brand: null,
                productName: null,
                title: null,
                packageType: 'unknown',
                keyText: [],
                colorSignature: ['brown', 'white'],
                layoutSignature: 'photo of cat',
                confidence: 0.99,
                rationale: 'Not a product'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/cat.jpg']);

      expect(result[0].kind).toBe('non_product');
      expect(result[0].panel).toBe('unknown');
    });

    it('should handle empty response gracefully', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({ items: [] })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/test.jpg']);

      expect(result).toEqual([]);
    });

    it('should handle side panels', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'side.jpg',
                kind: 'product',
                panel: 'side',
                brand: 'TestBrand',
                productName: 'Test Product',
                title: null,
                packageType: 'box',
                keyText: ['Additional info'],
                colorSignature: ['blue'],
                layoutSignature: 'side panel',
                confidence: 0.88,
                rationale: 'Side information panel'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/side.jpg']);

      expect(result[0].panel).toBe('side');
    });

    it('should handle brandWebsite field', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'product.jpg',
                kind: 'product',
                panel: 'front',
                brand: 'Root',
                productName: 'Clean Slate',
                title: null,
                brandWebsite: 'https://rootbrands.com',
                packageType: 'bottle',
                keyText: [],
                colorSignature: [],
                layoutSignature: 'bottle',
                confidence: 0.92,
                rationale: 'Product with website'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/product.jpg']);

      expect(result[0].brandWebsite).toBe('https://rootbrands.com');
    });

    it('should handle categoryPath field', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'vitamin.jpg',
                kind: 'product',
                panel: 'front',
                brand: 'Nature Made',
                productName: 'Vitamin D3',
                title: null,
                packageType: 'bottle',
                keyText: [],
                categoryPath: 'Health & Personal Care > Vitamins & Dietary Supplements',
                colorSignature: [],
                layoutSignature: 'bottle',
                confidence: 0.94,
                rationale: 'Vitamin supplement'
              }]
            })
          }
        }]
      });

      const result = await classifyImagesBatch(['/tmp/vitamin.jpg']);

      expect(result[0].categoryPath).toBe('Health & Personal Care > Vitamins & Dietary Supplements');
    });
  });

  describe('Pairing Edge Cases', () => {
    it('should pair products with null brand on back panel', async () => {
      const classifications = [
        {
          filename: 'front.jpg',
          kind: 'product' as const,
          panel: 'front' as const,
          brand: 'TestBrand',
          productName: 'Test Product',
          title: null,
          packageType: 'bottle' as const,
          keyText: [],
          colorSignature: ['blue'],
          layoutSignature: 'front label',
          confidence: 0.95,
        },
        {
          filename: 'back.jpg',
          kind: 'product' as const,
          panel: 'back' as const,
          brand: null,
          productName: null,
          title: null,
          packageType: 'bottle' as const,
          keyText: ['Supplement Facts'],
          colorSignature: ['blue'],
          layoutSignature: 'supplement facts',
          confidence: 0.90,
        }
      ];

      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Soft match: same package type and colors',
                confidence: 0.88
              }],
              unpaired: []
            })
          }
        }]
      });

      const result = await pairFromClassifications(classifications);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].back).toBe('back.jpg');
    });

    it('should handle side panel pairing', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'front.jpg',
                back: 'side.jpg',
                reasoning: 'Front paired with side panel',
                confidence: 0.85
              }],
              unpaired: []
            })
          }
        }]
      });

      const result = await pairFromClassifications([
        {
          filename: 'front.jpg',
          kind: 'product',
          panel: 'front',
          brand: 'Test',
          productName: 'Product',
          title: null,
          packageType: 'box',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'front',
          confidence: 0.9,
        },
        {
          filename: 'side.jpg',
          kind: 'product',
          panel: 'side',
          brand: 'Test',
          productName: 'Product',
          title: null,
          packageType: 'box',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'side',
          confidence: 0.85,
        }
      ]);

      expect(result.pairs[0].back).toBe('side.jpg');
    });

    it('should leave non-products unpaired', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [],
              unpaired: [{
                filename: 'cat.jpg',
                reason: 'Non-product image',
                needsReview: false
              }]
            })
          }
        }]
      });

      const result = await pairFromClassifications([
        {
          filename: 'cat.jpg',
          kind: 'non_product',
          panel: 'unknown',
          brand: null,
          productName: null,
          title: null,
          packageType: 'unknown',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'photo',
          confidence: 0.95,
        }
      ]);

      expect(result.unpaired).toHaveLength(1);
      expect(result.unpaired[0].reason).toBe('Non-product image');
    });

    it('should handle empty classification array', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [],
              unpaired: []
            })
          }
        }]
      });

      const result = await pairFromClassifications([]);

      expect(result.pairs).toEqual([]);
      // Empty array still goes through pairing, returns empty result
      expect(Array.isArray(result.unpaired)).toBe(true);
    });

    it('should handle JSON parse errors gracefully', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: 'invalid json'
          }
        }]
      });

      const result = await pairFromClassifications([
        {
          filename: 'test.jpg',
          kind: 'product',
          panel: 'front',
          brand: 'Test',
          productName: 'Test',
          title: null,
          packageType: 'bottle',
          keyText: [],
          colorSignature: [],
          layoutSignature: 'test',
          confidence: 0.9,
        }
      ]);

      expect(result.pairs).toEqual([]);
      expect(result.unpaired[0].reason).toBe('Pairing failed due to error');
    });
  });

  describe('Verification Edge Cases', () => {
    it('should accept pairs with matching productName when brand is null', async () => {
      const classifications = [
        {
          filename: 'front.jpg',
          kind: 'product' as const,
          panel: 'front' as const,
          brand: 'TestBrand',
          productName: 'Vitamin C',
          title: null,
          packageType: 'bottle' as const,
          keyText: [],
          colorSignature: [],
          layoutSignature: 'front',
          confidence: 0.95,
        },
        {
          filename: 'back.jpg',
          kind: 'product' as const,
          panel: 'back' as const,
          brand: null,
          productName: 'Vitamin C',
          title: null,
          packageType: 'bottle' as const,
          keyText: [],
          colorSignature: [],
          layoutSignature: 'back',
          confidence: 0.90,
        }
      ];

      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'ProductName match',
                confidence: 0.90,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await verifyPairs(classifications, {
        pairs: [{
          front: 'front.jpg',
          back: 'back.jpg',
          reasoning: 'Match',
          confidence: 0.90
        }],
        unpaired: []
      });

      expect(result.verifiedPairs[0].status).toBe('accepted');
    });

    it('should reject pairs with conflicting brands', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Brand mismatch',
                confidence: 0.50,
                status: 'rejected',
                issues: ['Brand mismatch: Nike vs Adidas']
              }]
            })
          }
        }]
      });

      const result = await verifyPairs(
        [
          {
            filename: 'front.jpg',
            kind: 'product',
            panel: 'front',
            brand: 'Nike',
            productName: 'Shoes',
            title: null,
            packageType: 'box',
            keyText: [],
            colorSignature: [],
            layoutSignature: 'box',
            confidence: 0.95,
          },
          {
            filename: 'back.jpg',
            kind: 'product',
            panel: 'back',
            brand: 'Adidas',
            productName: 'Shoes',
            title: null,
            packageType: 'box',
            keyText: [],
            colorSignature: [],
            layoutSignature: 'box',
            confidence: 0.92,
          }
        ],
        {
          pairs: [{
            front: 'front.jpg',
            back: 'back.jpg',
            reasoning: 'Test',
            confidence: 0.50
          }],
          unpaired: []
        }
      );

      expect(result.verifiedPairs[0].status).toBe('rejected');
      expect(result.verifiedPairs[0].issues).toContain('Brand mismatch: Nike vs Adidas');
    });

    it('should accept pairs with similar package types', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Similar package types acceptable',
                confidence: 0.87,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await verifyPairs(
        [
          {
            filename: 'front.jpg',
            kind: 'product',
            panel: 'front',
            brand: 'Test',
            productName: 'Product',
            title: null,
            packageType: 'bottle',
            keyText: [],
            colorSignature: [],
            layoutSignature: 'bottle',
            confidence: 0.90,
          },
          {
            filename: 'back.jpg',
            kind: 'product',
            panel: 'back',
            brand: 'Test',
            productName: 'Product',
            title: null,
            packageType: 'jar',
            keyText: [],
            colorSignature: [],
            layoutSignature: 'jar',
            confidence: 0.88,
          }
        ],
        {
          pairs: [{
            front: 'front.jpg',
            back: 'back.jpg',
            reasoning: 'Similar types',
            confidence: 0.87
          }],
          unpaired: []
        }
      );

      expect(result.verifiedPairs[0].status).toBe('accepted');
    });

    it('should handle missing classifications gracefully', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'missing.jpg',
                back: 'back.jpg',
                reasoning: 'Verification attempted',
                confidence: 0.80,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await verifyPairs(
        [],
        {
          pairs: [{
            front: 'missing.jpg',
            back: 'back.jpg',
            reasoning: 'Test',
            confidence: 0.80
          }],
          unpaired: []
        }
      );

      expect(result.verifiedPairs).toHaveLength(1);
    });

    it('should handle empty pairs array', async () => {
      mockOpenAI.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: []
            })
          }
        }]
      });

      const result = await verifyPairs([], { pairs: [], unpaired: [] });

      expect(result.verifiedPairs).toEqual([]);
    });
  });

  describe('runNewTwoStagePipeline Integration', () => {
    // Import the main pipeline function
    const { runNewTwoStagePipeline } = require('../src/smartdrafts/pairing-v2-core');

    it('should complete full pipeline successfully', async () => {
      // Mock classification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [
                {
                  filename: 'test-front.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: 'TestBrand',
                  productName: 'Test Product',
                  title: null,
                  packageType: 'bottle',
                  keyText: ['Test', 'Product'],
                  categoryPath: 'Health & Personal Care',
                  colorSignature: ['blue', 'white'],
                  layoutSignature: 'front label',
                  confidence: 0.95,
                  quantityInPhoto: 1,
                  rationale: 'Front panel'
                },
                {
                  filename: 'test-back.jpg',
                  kind: 'product',
                  panel: 'back',
                  brand: 'TestBrand',
                  productName: 'Test Product',
                  title: null,
                  packageType: 'bottle',
                  keyText: ['Supplement Facts'],
                  categoryPath: 'Health & Personal Care',
                  colorSignature: ['white'],
                  layoutSignature: 'supplement facts',
                  confidence: 0.90,
                  quantityInPhoto: 1,
                  rationale: 'Back panel'
                }
              ]
            })
          }
        }]
      });

      // Mock pairing
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'test-front.jpg',
                back: 'test-back.jpg',
                reasoning: 'Matching brand and product',
                confidence: 0.92
              }],
              unpaired: []
            })
          }
        }]
      });

      // Mock verification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'test-front.jpg',
                back: 'test-back.jpg',
                reasoning: 'Verified match',
                confidence: 0.92,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await runNewTwoStagePipeline([
        '/tmp/test-front.jpg',
        '/tmp/test-back.jpg'
      ]);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].front).toBe('test-front.jpg');
      expect(result.pairs[0].back).toBe('test-back.jpg');
      expect(result.pairs[0].brand).toBe('TestBrand');
      expect(result.pairs[0].product).toBe('Test Product');
      expect(result.pairs[0].photoQuantity).toBe(1);
      expect(result.unpaired).toHaveLength(0);
      expect(result.metrics.totals.images).toBe(2);
      expect(result.metrics.totals.modelPairs).toBe(1);
    });

    it('should handle rejected pairs in pipeline', async () => {
      // Mock classification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [
                {
                  filename: 'front.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: 'Brand1',
                  productName: 'Product1',
                  title: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'front',
                  confidence: 0.9,
                  quantityInPhoto: 1,
                  rationale: 'Front'
                },
                {
                  filename: 'back.jpg',
                  kind: 'product',
                  panel: 'back',
                  brand: 'Brand2',
                  productName: 'Product2',
                  title: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'back',
                  confidence: 0.9,
                  quantityInPhoto: 1,
                  rationale: 'Back'
                }
              ]
            })
          }
        }]
      });

      // Mock pairing
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Attempted pair',
                confidence: 0.7
              }],
              unpaired: []
            })
          }
        }]
      });

      // Mock verification - reject the pair
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Brand mismatch',
                confidence: 0.7,
                status: 'rejected',
                issues: ['Different brands']
              }]
            })
          }
        }]
      });

      const result = await runNewTwoStagePipeline(['/tmp/front.jpg', '/tmp/back.jpg']);

      expect(result.pairs).toHaveLength(0);
      expect(result.unpaired).toHaveLength(2);
      expect(result.unpaired.some(u => u.imagePath === 'front.jpg')).toBe(true);
      expect(result.unpaired.some(u => u.imagePath === 'back.jpg')).toBe(true);
    });

    it('should calculate photoQuantity as max of front and back', async () => {
      // Mock classification with different quantities
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [
                {
                  filename: 'multi-front.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: 'Test',
                  productName: 'Test',
                  title: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'front',
                  confidence: 0.9,
                  quantityInPhoto: 3,
                  rationale: 'Multiple bottles visible'
                },
                {
                  filename: 'multi-back.jpg',
                  kind: 'product',
                  panel: 'back',
                  brand: 'Test',
                  productName: 'Test',
                  title: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'back',
                  confidence: 0.9,
                  quantityInPhoto: 1,
                  rationale: 'Single bottle visible'
                }
              ]
            })
          }
        }]
      });

      // Mock pairing
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'multi-front.jpg',
                back: 'multi-back.jpg',
                reasoning: 'Match',
                confidence: 0.9
              }],
              unpaired: []
            })
          }
        }]
      });

      // Mock verification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'multi-front.jpg',
                back: 'multi-back.jpg',
                reasoning: 'Match',
                confidence: 0.9,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await runNewTwoStagePipeline(['/tmp/multi-front.jpg', '/tmp/multi-back.jpg']);

      expect(result.pairs[0].photoQuantity).toBe(3); // Max of 3 and 1
    });

    it('should handle books in pipeline', async () => {
      // Mock classification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [
                {
                  filename: 'book.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: null,
                  productName: 'Stephen King',
                  title: 'The Shining',
                  packageType: 'book',
                  keyText: [],
                  brandWebsite: null,
                  categoryPath: 'Books > Horror',
                  colorSignature: [],
                  layoutSignature: 'book cover',
                  confidence: 0.95,
                  quantityInPhoto: 1,
                  rationale: 'Book'
                }
              ]
            })
          }
        }]
      });

      // Mock pairing
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [],
              unpaired: [{
                filename: 'book.jpg',
                reason: 'Single book, no back panel',
                needsReview: false
              }]
            })
          }
        }]
      });

      const result = await runNewTwoStagePipeline(['/tmp/book.jpg']);

      expect(result.unpaired).toHaveLength(1);
      expect(result.unpaired[0].title).toBe('The Shining');
      expect(result.unpaired[0].brand).toBeNull();
      expect(result.unpaired[0].categoryPath).toBe('Books > Horror');
    });

    it('should populate metrics correctly', async () => {
      // Mock classification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [
                {
                  filename: 'front1.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: 'BrandA',
                  productName: 'ProductA',
                  title: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'front',
                  confidence: 0.95,
                  quantityInPhoto: 1,
                  rationale: 'Front A'
                },
                {
                  filename: 'back1.jpg',
                  kind: 'product',
                  panel: 'back',
                  brand: 'BrandA',
                  productName: 'ProductA',
                  title: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'back',
                  confidence: 0.90,
                  quantityInPhoto: 1,
                  rationale: 'Back A'
                },
                {
                  filename: 'front2.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: 'BrandB',
                  productName: 'ProductB',
                  title: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'front',
                  confidence: 0.92,
                  quantityInPhoto: 1,
                  rationale: 'Front B'
                }
              ]
            })
          }
        }]
      });

      // Mock pairing - pair only the first
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'front1.jpg',
                back: 'back1.jpg',
                reasoning: 'Match',
                confidence: 0.92
              }],
              unpaired: [{
                filename: 'front2.jpg',
                reason: 'No matching back',
                needsReview: true
              }]
            })
          }
        }]
      });

      // Mock verification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front1.jpg',
                back: 'back1.jpg',
                reasoning: 'Match',
                confidence: 0.92,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await runNewTwoStagePipeline([
        '/tmp/front1.jpg',
        '/tmp/back1.jpg',
        '/tmp/front2.jpg'
      ]);

      expect(result.metrics.totals.images).toBe(3);
      expect(result.metrics.totals.fronts).toBe(2);
      expect(result.metrics.totals.backs).toBe(1);
      expect(result.metrics.totals.modelPairs).toBe(1);
      expect(result.metrics.totals.singletons).toBe(1);
      expect(result.metrics.byBrand['branda']).toBeDefined();
      expect(result.metrics.byBrand['branda'].fronts).toBe(1);
      expect(result.metrics.byBrand['branda'].paired).toBe(1);
      expect(result.metrics.reasons['No matching back']).toBe(1);
    });

    it('should handle multiple batches of images', async () => {
      // Create 25 mock images to trigger batch processing (batch size is typically 12)
      const imagePaths = Array.from({ length: 25 }, (_, i) => `/tmp/image${i}.jpg`);
      
      // Mock classification - first batch (12 images)
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: Array.from({ length: 12 }, (_, i) => ({
                filename: `image${i}.jpg`,
                kind: 'product',
                panel: i % 2 === 0 ? 'front' : 'back',
                brand: 'TestBrand',
                productName: 'Test',
                title: null,
                packageType: 'bottle',
                keyText: [],
                colorSignature: [],
                layoutSignature: 'test',
                confidence: 0.9,
                quantityInPhoto: 1,
                rationale: 'Test'
              }))
            })
          }
        }]
      });

      // Mock classification - second batch (12 images)
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: Array.from({ length: 12 }, (_, i) => ({
                filename: `image${i + 12}.jpg`,
                kind: 'product',
                panel: i % 2 === 0 ? 'front' : 'back',
                brand: 'TestBrand',
                productName: 'Test',
                title: null,
                packageType: 'bottle',
                keyText: [],
                colorSignature: [],
                layoutSignature: 'test',
                confidence: 0.9,
                quantityInPhoto: 1,
                rationale: 'Test'
              }))
            })
          }
        }]
      });

      // Mock classification - third batch (1 image)
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [{
                filename: 'image24.jpg',
                kind: 'product',
                panel: 'front',
                brand: 'TestBrand',
                productName: 'Test',
                title: null,
                packageType: 'bottle',
                keyText: [],
                colorSignature: [],
                layoutSignature: 'test',
                confidence: 0.9,
                quantityInPhoto: 1,
                rationale: 'Test'
              }]
            })
          }
        }]
      });

      // Mock pairing
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [],
              unpaired: imagePaths.map(p => ({
                filename: p.split('/').pop(),
                reason: 'Test unpaired',
                needsReview: false
              }))
            })
          }
        }]
      });

      const result = await runNewTwoStagePipeline(imagePaths);

      expect(result.metrics.totals.images).toBe(25);
    });

    it('should handle brandWebsite in pipeline output', async () => {
      // Mock classification with brandWebsite
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              items: [
                {
                  filename: 'front.jpg',
                  kind: 'product',
                  panel: 'front',
                  brand: 'Root',
                  productName: 'Clean Slate',
                  title: null,
                  brandWebsite: 'https://rootbrands.com',
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'front',
                  confidence: 0.95,
                  quantityInPhoto: 1,
                  rationale: 'Front'
                },
                {
                  filename: 'back.jpg',
                  kind: 'product',
                  panel: 'back',
                  brand: null,
                  productName: null,
                  title: null,
                  brandWebsite: null,
                  packageType: 'bottle',
                  keyText: [],
                  colorSignature: [],
                  layoutSignature: 'back',
                  confidence: 0.90,
                  quantityInPhoto: 1,
                  rationale: 'Back'
                }
              ]
            })
          }
        }]
      });

      // Mock pairing
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              pairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Match',
                confidence: 0.92
              }],
              unpaired: []
            })
          }
        }]
      });

      // Mock verification
      mockOpenAI.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedPairs: [{
                front: 'front.jpg',
                back: 'back.jpg',
                reasoning: 'Match',
                confidence: 0.92,
                status: 'accepted'
              }]
            })
          }
        }]
      });

      const result = await runNewTwoStagePipeline(['/tmp/front.jpg', '/tmp/back.jpg']);

      expect(result.pairs[0].brandWebsite).toBe('https://rootbrands.com');
    });
  });
});
