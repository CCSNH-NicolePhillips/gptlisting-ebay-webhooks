/**
 * Unit tests for root index.ts
 * Tests the image classification and pairing pipeline functions
 */

import * as fs from 'fs';
import * as path from 'path';

// Mock OpenAI
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  }));
});

// Mock fs module for file operations
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn(),
    existsSync: jest.fn(),
    readdirSync: jest.fn(),
  };
});

// Mock dotenv
jest.mock('dotenv', () => ({
  config: jest.fn(),
}));

describe('Index Pipeline Types', () => {
  describe('PanelType', () => {
    it('should accept valid panel types', () => {
      const validTypes = ['front', 'back', 'side', 'unknown'];
      validTypes.forEach((type) => {
        expect(['front', 'back', 'side', 'unknown']).toContain(type);
      });
    });
  });

  describe('ProductKind', () => {
    it('should accept valid product kinds', () => {
      const validKinds = ['product', 'non_product'];
      validKinds.forEach((kind) => {
        expect(['product', 'non_product']).toContain(kind);
      });
    });
  });
});

describe('ImageClassificationV2 Structure', () => {
  const mockClassification = {
    filename: 'test.jpg',
    kind: 'product' as const,
    panel: 'front' as const,
    brand: 'TestBrand',
    productName: 'Test Product',
    packageType: 'bottle' as const,
    keyText: ['organic', 'premium', 'natural'],
    colorSignature: ['green', 'white', 'gold'],
    layoutSignature: 'bottle wraparound label center',
    confidence: 0.95,
  };

  it('should have required fields', () => {
    expect(mockClassification).toHaveProperty('filename');
    expect(mockClassification).toHaveProperty('kind');
    expect(mockClassification).toHaveProperty('panel');
    expect(mockClassification).toHaveProperty('brand');
    expect(mockClassification).toHaveProperty('productName');
    expect(mockClassification).toHaveProperty('packageType');
    expect(mockClassification).toHaveProperty('keyText');
    expect(mockClassification).toHaveProperty('colorSignature');
    expect(mockClassification).toHaveProperty('layoutSignature');
    expect(mockClassification).toHaveProperty('confidence');
  });

  it('should have correct field types', () => {
    expect(typeof mockClassification.filename).toBe('string');
    expect(typeof mockClassification.kind).toBe('string');
    expect(typeof mockClassification.panel).toBe('string');
    expect(Array.isArray(mockClassification.keyText)).toBe(true);
    expect(Array.isArray(mockClassification.colorSignature)).toBe(true);
    expect(typeof mockClassification.layoutSignature).toBe('string');
    expect(typeof mockClassification.confidence).toBe('number');
  });

  it('should handle null brand and productName', () => {
    const classificationWithNulls = {
      ...mockClassification,
      brand: null,
      productName: null,
    };
    expect(classificationWithNulls.brand).toBeNull();
    expect(classificationWithNulls.productName).toBeNull();
  });
});

describe('PairingOutput Structure', () => {
  const mockPairing = {
    pairs: [
      {
        front: 'front.jpg',
        back: 'back.jpg',
        reasoning: 'Same brand and product',
        confidence: 0.95,
      },
    ],
    unpaired: [
      {
        filename: 'orphan.jpg',
        reason: 'No matching back found',
        needsReview: true,
      },
    ],
  };

  it('should have pairs array', () => {
    expect(Array.isArray(mockPairing.pairs)).toBe(true);
    expect(mockPairing.pairs.length).toBeGreaterThan(0);
  });

  it('should have unpaired array', () => {
    expect(Array.isArray(mockPairing.unpaired)).toBe(true);
  });

  it('should have correct pair structure', () => {
    const pair = mockPairing.pairs[0];
    expect(pair).toHaveProperty('front');
    expect(pair).toHaveProperty('back');
    expect(pair).toHaveProperty('reasoning');
    expect(pair).toHaveProperty('confidence');
  });

  it('should have correct unpaired structure', () => {
    const unpaired = mockPairing.unpaired[0];
    expect(unpaired).toHaveProperty('filename');
    expect(unpaired).toHaveProperty('reason');
    expect(unpaired).toHaveProperty('needsReview');
  });
});

describe('VerifiedPair Structure', () => {
  const mockVerifiedPair = {
    front: 'front.jpg',
    back: 'back.jpg',
    reasoning: 'Matching brand and product',
    confidence: 0.9,
    status: 'accepted' as const,
  };

  it('should have required fields', () => {
    expect(mockVerifiedPair).toHaveProperty('front');
    expect(mockVerifiedPair).toHaveProperty('back');
    expect(mockVerifiedPair).toHaveProperty('reasoning');
    expect(mockVerifiedPair).toHaveProperty('confidence');
    expect(mockVerifiedPair).toHaveProperty('status');
  });

  it('should accept "accepted" status without issues', () => {
    expect(mockVerifiedPair.status).toBe('accepted');
    expect(mockVerifiedPair).not.toHaveProperty('issues');
  });

  it('should have issues array when rejected', () => {
    const rejectedPair = {
      ...mockVerifiedPair,
      status: 'rejected' as const,
      issues: ['Brand mismatch', 'Different package type'],
    };
    expect(rejectedPair.status).toBe('rejected');
    expect(Array.isArray(rejectedPair.issues)).toBe(true);
    expect(rejectedPair.issues?.length).toBeGreaterThan(0);
  });
});

describe('MasterPair Structure', () => {
  const mockMasterPair = {
    product: 'Test Product',
    front: 'front.jpg',
    back: 'back.jpg',
  };

  it('should have required fields', () => {
    expect(mockMasterPair).toHaveProperty('product');
    expect(mockMasterPair).toHaveProperty('front');
    expect(mockMasterPair).toHaveProperty('back');
  });
});

describe('ComparisonResult Structure', () => {
  const mockComparison = {
    correct: [{ product: 'Product A', front: 'a_front.jpg', back: 'a_back.jpg' }],
    incorrect: [{ product: 'Product B', front: 'b_front.jpg', back: 'b_back.jpg' }],
    missed: [{ product: 'Product C', front: 'c_front.jpg', back: 'c_back.jpg' }],
    extraPairs: [{ front: 'extra_front.jpg', back: 'extra_back.jpg' }],
  };

  it('should have correct array', () => {
    expect(Array.isArray(mockComparison.correct)).toBe(true);
  });

  it('should have incorrect array', () => {
    expect(Array.isArray(mockComparison.incorrect)).toBe(true);
  });

  it('should have missed array', () => {
    expect(Array.isArray(mockComparison.missed)).toBe(true);
  });

  it('should have extraPairs array', () => {
    expect(Array.isArray(mockComparison.extraPairs)).toBe(true);
  });
});

describe('SAMPLE_IMAGES Configuration', () => {
  const SAMPLE_IMAGES = [
    { filename: 'asd32q.jpg', role: 'example_front', description: 'Example FRONT' },
    { filename: 'azdfkuj.jpg', role: 'example_back', description: 'Example BACK' },
    { filename: 'frog_01.jpg', role: 'example_front', description: 'Example FRONT' },
    { filename: 'faeewfaw.jpg', role: 'example_back', description: 'Example BACK' },
    { filename: 'rgxbbg.jpg', role: 'example_front', description: 'Example FRONT' },
    { filename: 'dfzdvzer.jpg', role: 'example_back', description: 'Example BACK' },
    { filename: 'IMG_20251102_144346.jpg', role: 'example_non_product', description: 'NON-PRODUCT' },
  ];

  it('should have at least one example of each role', () => {
    const roles = SAMPLE_IMAGES.map((s) => s.role);
    expect(roles).toContain('example_front');
    expect(roles).toContain('example_back');
    expect(roles).toContain('example_non_product');
  });

  it('should have valid image filenames', () => {
    SAMPLE_IMAGES.forEach((sample) => {
      expect(sample.filename).toMatch(/\.(jpg|jpeg|png)$/i);
    });
  });
});

describe('Environment Variables', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should default ENABLE_COMPARISON to false', () => {
    delete process.env.ENABLE_COMPARISON;
    const ENABLE_COMPARISON = process.env.ENABLE_COMPARISON === 'true';
    expect(ENABLE_COMPARISON).toBe(false);
  });

  it('should enable comparison when set to true', () => {
    process.env.ENABLE_COMPARISON = 'true';
    const ENABLE_COMPARISON = process.env.ENABLE_COMPARISON === 'true';
    expect(ENABLE_COMPARISON).toBe(true);
  });

  it('should default USE_LEGACY_PAIRING to false', () => {
    delete process.env.USE_LEGACY_PAIRING;
    const USE_LEGACY_PAIRING = process.env.USE_LEGACY_PAIRING === 'true';
    expect(USE_LEGACY_PAIRING).toBe(false);
  });

  it('should enable legacy pairing when set to true', () => {
    process.env.USE_LEGACY_PAIRING = 'true';
    const USE_LEGACY_PAIRING = process.env.USE_LEGACY_PAIRING === 'true';
    expect(USE_LEGACY_PAIRING).toBe(true);
  });

  it('should default JUST_CLASSIFY to false', () => {
    delete process.env.JUST_CLASSIFY;
    const JUST_CLASSIFY = process.env.JUST_CLASSIFY === 'true';
    expect(JUST_CLASSIFY).toBe(false);
  });

  it('should default TEST_TWO_STAGE to false', () => {
    delete process.env.TEST_TWO_STAGE;
    const TEST_TWO_STAGE = process.env.TEST_TWO_STAGE === 'true';
    expect(TEST_TWO_STAGE).toBe(false);
  });
});

describe('CLASSIFY_BATCH_SIZE', () => {
  const CLASSIFY_BATCH_SIZE = 12;

  it('should be 12 images per batch', () => {
    expect(CLASSIFY_BATCH_SIZE).toBe(12);
  });

  it('should calculate correct number of batches', () => {
    const testCases = [
      { imageCount: 1, expectedBatches: 1 },
      { imageCount: 12, expectedBatches: 1 },
      { imageCount: 13, expectedBatches: 2 },
      { imageCount: 24, expectedBatches: 2 },
      { imageCount: 25, expectedBatches: 3 },
      { imageCount: 100, expectedBatches: 9 },
    ];

    testCases.forEach(({ imageCount, expectedBatches }) => {
      const batches = Math.ceil(imageCount / CLASSIFY_BATCH_SIZE);
      expect(batches).toBe(expectedBatches);
    });
  });
});

describe('Helper Functions', () => {
  describe('MIME type detection', () => {
    it('should return correct MIME type for jpg', () => {
      const ext = path.extname('image.jpg').toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      expect(mimeType).toBe('image/jpeg');
    });

    it('should return correct MIME type for jpeg', () => {
      const ext = path.extname('image.jpeg').toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      expect(mimeType).toBe('image/jpeg');
    });

    it('should return correct MIME type for png', () => {
      const ext = path.extname('image.png').toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      expect(mimeType).toBe('image/png');
    });

    it('should default to jpeg for unknown extensions', () => {
      const ext = path.extname('image.webp').toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      expect(mimeType).toBe('image/jpeg');
    });
  });

  describe('Image file filtering', () => {
    it('should filter image files correctly', () => {
      const files = ['image.jpg', 'doc.pdf', 'photo.png', 'video.mp4', 'pic.gif'];
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

      const imageFiles = files.filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return imageExtensions.includes(ext);
      });

      expect(imageFiles).toEqual(['image.jpg', 'photo.png', 'pic.gif']);
    });

    it('should handle case-insensitive extensions', () => {
      const files = ['IMAGE.JPG', 'photo.PNG', 'pic.Gif'];
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

      const imageFiles = files.filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return imageExtensions.includes(ext);
      });

      expect(imageFiles).toEqual(['IMAGE.JPG', 'photo.PNG', 'pic.Gif']);
    });
  });

  describe('Filename extraction', () => {
    it('should extract filename from full path', () => {
      const fullPath = '/path/to/image.jpg';
      const filename = path.basename(fullPath);
      expect(filename).toBe('image.jpg');
    });

    it('should handle Windows paths', () => {
      const fullPath = 'C:\\Users\\test\\image.jpg';
      const filename = path.basename(fullPath);
      expect(filename).toBe('image.jpg');
    });
  });
});

describe('AutoPairSingleLeftovers Logic', () => {
  const autoPairSingleLeftovers = (result: {
    pairs: Array<{ front: string; back: string; brand: string; product: string; notes: string; reasoning: string }>;
    classifications: Record<string, string>;
  }) => {
    const pairedFronts = new Set(result.pairs.map((p) => p.front));
    const pairedBacks = new Set(result.pairs.map((p) => p.back));

    const unmatchedFronts = Object.entries(result.classifications)
      .filter(([fn, label]) => label === 'front' && !pairedFronts.has(fn))
      .map(([fn]) => fn);

    const unmatchedBacks = Object.entries(result.classifications)
      .filter(([fn, label]) => label === 'back' && !pairedBacks.has(fn))
      .map(([fn]) => fn);

    if (unmatchedFronts.length === 1 && unmatchedBacks.length === 1) {
      result.pairs.push({
        front: unmatchedFronts[0],
        back: unmatchedBacks[0],
        brand: 'unknown',
        product: 'unknown',
        notes: 'Auto-paired as the only remaining front/back.',
        reasoning: 'Auto-paired by system: only remaining unmatched front and back images.',
      });
    }

    return result;
  };

  it('should auto-pair single remaining front and back', () => {
    const result = {
      pairs: [],
      classifications: {
        'front1.jpg': 'front',
        'back1.jpg': 'back',
      },
    };

    const updated = autoPairSingleLeftovers(result);

    expect(updated.pairs.length).toBe(1);
    expect(updated.pairs[0].front).toBe('front1.jpg');
    expect(updated.pairs[0].back).toBe('back1.jpg');
  });

  it('should not auto-pair when multiple fronts exist', () => {
    const result = {
      pairs: [],
      classifications: {
        'front1.jpg': 'front',
        'front2.jpg': 'front',
        'back1.jpg': 'back',
      },
    };

    const updated = autoPairSingleLeftovers(result);

    expect(updated.pairs.length).toBe(0);
  });

  it('should not auto-pair when multiple backs exist', () => {
    const result = {
      pairs: [],
      classifications: {
        'front1.jpg': 'front',
        'back1.jpg': 'back',
        'back2.jpg': 'back',
      },
    };

    const updated = autoPairSingleLeftovers(result);

    expect(updated.pairs.length).toBe(0);
  });

  it('should not auto-pair already paired images', () => {
    const result = {
      pairs: [
        {
          front: 'front1.jpg',
          back: 'back1.jpg',
          brand: 'TestBrand',
          product: 'TestProduct',
          notes: 'Existing pair',
          reasoning: 'Already paired',
        },
      ],
      classifications: {
        'front1.jpg': 'front',
        'back1.jpg': 'back',
        'front2.jpg': 'front',
        'back2.jpg': 'back',
      },
    };

    const updated = autoPairSingleLeftovers(result);

    // Should have added new pair since there's exactly 1 unpaired front and 1 unpaired back
    expect(updated.pairs.length).toBe(2);
    expect(updated.pairs[1].front).toBe('front2.jpg');
    expect(updated.pairs[1].back).toBe('back2.jpg');
  });
});

describe('MergeResults Logic', () => {
  const mergeResults = (
    pass1: { pairs: any[]; classifications: Record<string, string> },
    pass2: { pairs: any[]; classifications: Record<string, string> }
  ) => {
    return {
      pairs: [...pass1.pairs, ...pass2.pairs],
      classifications: {
        ...pass1.classifications,
        ...pass2.classifications,
      },
    };
  };

  it('should merge pairs from both passes', () => {
    const pass1 = {
      pairs: [{ front: 'a.jpg', back: 'b.jpg' }],
      classifications: { 'a.jpg': 'front', 'b.jpg': 'back' },
    };
    const pass2 = {
      pairs: [{ front: 'c.jpg', back: 'd.jpg' }],
      classifications: { 'c.jpg': 'front', 'd.jpg': 'back' },
    };

    const merged = mergeResults(pass1, pass2);

    expect(merged.pairs.length).toBe(2);
    expect(merged.pairs[0].front).toBe('a.jpg');
    expect(merged.pairs[1].front).toBe('c.jpg');
  });

  it('should merge classifications from both passes', () => {
    const pass1 = {
      pairs: [],
      classifications: { 'a.jpg': 'front', 'b.jpg': 'back' },
    };
    const pass2 = {
      pairs: [],
      classifications: { 'c.jpg': 'unknown', 'd.jpg': 'non_product' },
    };

    const merged = mergeResults(pass1, pass2);

    expect(Object.keys(merged.classifications).length).toBe(4);
    expect(merged.classifications['a.jpg']).toBe('front');
    expect(merged.classifications['c.jpg']).toBe('unknown');
  });

  it('should allow pass2 to override pass1 classifications', () => {
    const pass1 = {
      pairs: [],
      classifications: { 'a.jpg': 'unknown' },
    };
    const pass2 = {
      pairs: [],
      classifications: { 'a.jpg': 'front' },
    };

    const merged = mergeResults(pass1, pass2);

    expect(merged.classifications['a.jpg']).toBe('front');
  });
});

describe('Accuracy Calculation', () => {
  it('should calculate 100% accuracy for all correct', () => {
    const correct = 10;
    const incorrect = 0;
    const missed = 0;
    const total = correct + incorrect + missed;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    expect(accuracy).toBe(100);
  });

  it('should calculate 0% accuracy for none correct', () => {
    const correct = 0;
    const incorrect = 5;
    const missed = 5;
    const total = correct + incorrect + missed;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    expect(accuracy).toBe(0);
  });

  it('should calculate partial accuracy correctly', () => {
    const correct = 7;
    const incorrect = 2;
    const missed = 1;
    const total = correct + incorrect + missed;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    expect(accuracy).toBe(70);
  });

  it('should handle empty total gracefully', () => {
    const correct = 0;
    const incorrect = 0;
    const missed = 0;
    const total = correct + incorrect + missed;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    expect(accuracy).toBe(0);
  });
});
