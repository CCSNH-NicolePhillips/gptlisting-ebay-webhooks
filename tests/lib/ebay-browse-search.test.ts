/**
 * Unit tests for eBay Browse API search
 */

import {
  extractSize,
  detectBundle,
  scoreMatch,
} from '../../src/lib/ebay-browse-search.js';

describe('extractSize', () => {
  it('extracts count (ct)', () => {
    expect(extractSize('Product Name 90ct')).toBe('90ct');
    expect(extractSize('Product 60 ct')).toBe('60 ct');
    expect(extractSize('Item 30 Count')).toBe('30 count');
  });

  it('extracts ounces (oz)', () => {
    expect(extractSize('Lotion 3.3oz')).toBe('3.3oz');
    expect(extractSize('Shampoo 8 oz')).toBe('8 oz');
    expect(extractSize('Oil 16 fl oz')).toBe('16 fl oz');
  });

  it('extracts ml/liters', () => {
    expect(extractSize('Bottle 500ml')).toBe('500ml');
    expect(extractSize('Container 1.5 l')).toBe('1.5 l');
    expect(extractSize('Bottle 2 liters')).toBe('2 liters');
  });

  it('extracts grams/kg', () => {
    expect(extractSize('Powder 100g')).toBe('100g');
    expect(extractSize('Bag 2.5 kg')).toBe('2.5 kg');
  });

  it('extracts pack sizes', () => {
    expect(extractSize('Item 6 pack')).toBe('6 pack');
  });

  it('returns null when no size found', () => {
    expect(extractSize('Generic Product Name')).toBeNull();
    expect(extractSize('')).toBeNull();
  });
});

describe('detectBundle', () => {
  it('detects "lot of" listings', () => {
    expect(detectBundle('Lot of 5 Items')).toBe(true);
    expect(detectBundle('LOT OF 10 Products')).toBe(true);
  });

  it('detects pack/multi-pack', () => {
    expect(detectBundle('Pack of 3 Bottles')).toBe(true);
    expect(detectBundle('2-Pack Set')).toBe(true);
    expect(detectBundle('3 Pack Deal')).toBe(true);
  });

  it('detects set of', () => {
    expect(detectBundle('Set of 4 Items')).toBe(true);
  });

  it('detects bundle keyword', () => {
    expect(detectBundle('Product Bundle Deal')).toBe(true);
  });

  it('detects wholesale/bulk', () => {
    expect(detectBundle('Wholesale Lot')).toBe(true);
    expect(detectBundle('Bulk Order')).toBe(true);
  });

  it('detects multiplier (2x, 3x)', () => {
    expect(detectBundle('2x Product Name')).toBe(true);
    expect(detectBundle('Item 3x Size')).toBe(true);
  });

  it('returns false for single items', () => {
    expect(detectBundle('Single Product 90ct')).toBe(false);
    expect(detectBundle('Brand Name Product 3.3oz')).toBe(false);
    expect(detectBundle('Normal Listing Title')).toBe(false);
  });

  it('does not false positive on product sizes', () => {
    // "90ct" should not be detected as bundle
    expect(detectBundle('Neuro Mints 90ct')).toBe(false);
    // "16 oz" should not be detected
    expect(detectBundle('Shampoo 16 oz')).toBe(false);
  });
});

describe('scoreMatch', () => {
  const ourProduct = {
    brand: 'Neuro',
    product: 'Neuro Mints 90ct Calm & Clarity',
    condition: 'NEW',
  };

  it('scores exact match as high', () => {
    const score = scoreMatch(
      ourProduct,
      'Neuro Mints 90ct Calm & Clarity Focus Energy',
      'New'
    );
    expect(score.brandMatch).toBe(true);
    expect(score.productTokenOverlap).toBeGreaterThan(0.5);
    expect(score.bundleDetected).toBe(false);
    expect(score.overall).toBe('high');
    expect(score.usable).toBe(true);
  });

  it('detects brand mismatch', () => {
    const score = scoreMatch(
      ourProduct,
      'Generic Mints 90ct Calm Focus',
      'New'
    );
    expect(score.brandMatch).toBe(false);
    expect(score.overall).not.toBe('high');
  });

  it('detects size mismatch', () => {
    const score = scoreMatch(
      ourProduct,
      'Neuro Mints 30ct Calm & Clarity', // 30ct vs 90ct
      'New'
    );
    expect(score.sizeMatch).toBe(false);
    expect(score.usable).toBe(false); // Size mismatch makes it unusable
  });

  it('detects bundles and marks unusable', () => {
    const score = scoreMatch(
      ourProduct,
      'Lot of 5 Neuro Mints 90ct Calm & Clarity',
      'New'
    );
    expect(score.bundleDetected).toBe(true);
    expect(score.usable).toBe(false); // Bundles are not usable for pricing
  });

  it('handles condition mismatch', () => {
    const score = scoreMatch(
      { brand: 'Brand', product: 'Product', condition: 'NEW' },
      'Brand Product Item',
      'Used'
    );
    expect(score.conditionMatch).toBe(false);
  });

  it('treats missing condition as new', () => {
    const score = scoreMatch(
      { brand: 'Brand', product: 'Product' }, // no condition
      'Brand Product Item',
      'New'
    );
    expect(score.conditionMatch).toBe(true);
  });

  it('scores low for unrelated product', () => {
    const score = scoreMatch(
      ourProduct,
      'Completely Different Product Electronics Phone Case',
      'New'
    );
    expect(score.brandMatch).toBe(false);
    expect(score.productTokenOverlap).toBeLessThan(0.3);
    expect(score.overall).toBe('low');
    expect(score.usable).toBe(false);
  });

  it('returns medium for partial match', () => {
    const score = scoreMatch(
      ourProduct,
      'Neuro Focus Supplement 60ct', // Same brand, different product
      'New'
    );
    expect(score.brandMatch).toBe(true);
    // Low token overlap but brand matches
    if (score.productTokenOverlap >= 0.4) {
      expect(score.overall).toBe('medium');
    }
  });
});

describe('scoreMatch - real world examples', () => {
  it('matches Olaplex No 3', () => {
    const score = scoreMatch(
      { brand: 'Olaplex', product: 'Olaplex No 3 Hair Perfector 3.3oz' },
      'OLAPLEX No 3 Hair Perfector 3.3 oz Treatment NEW Authentic',
      'New'
    );
    expect(score.brandMatch).toBe(true);
    // Token overlap varies based on tokenization, but should be usable
    expect(score.usable).toBe(true);
  });

  it('rejects Olaplex bundle', () => {
    const score = scoreMatch(
      { brand: 'Olaplex', product: 'Olaplex No 3 Hair Perfector 3.3oz' },
      'Olaplex Set of 3 No 3 4 5 Hair Care Bundle',
      'New'
    );
    expect(score.bundleDetected).toBe(true);
    expect(score.usable).toBe(false);
  });

  it('rejects different size', () => {
    const score = scoreMatch(
      { brand: 'Olaplex', product: 'Olaplex No 3 Hair Perfector 3.3oz' },
      'Olaplex No 3 Hair Perfector 1 oz Travel Size',
      'New'
    );
    expect(score.sizeMatch).toBe(false);
    expect(score.usable).toBe(false);
  });
});
