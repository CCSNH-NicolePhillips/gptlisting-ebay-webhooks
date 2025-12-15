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
});
