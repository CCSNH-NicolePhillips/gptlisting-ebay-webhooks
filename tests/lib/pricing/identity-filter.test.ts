/**
 * Chunk 4 — Identity/variant filtering unit tests.
 *
 * Covers:
 *  - extractCount         (supplement unit count)
 *  - extractPackMultiplier (2-pack / single)
 *  - extractVolumeSize    (oz / ml / g)
 *  - extractStrength      (mg / mcg / iu / %)
 *  - extractCfuBillions   (probiotic CFU)
 *  - extractModelNumber   (model# prefix)
 *  - strictMatchIdentity  (integration: query vs comp)
 */

import {
  extractCount,
  extractPackMultiplier,
  extractVolumeSize,
  extractStrength,
  extractCfuBillions,
  extractModelNumber,
  extractIdentity,
} from '../../../src/lib/pricing/identity-model.js';

import { strictMatchIdentity } from '../../../src/lib/pricing/comp-matcher.js';

// ─── extractCount ─────────────────────────────────────────────────────────────

describe('extractCount', () => {
  it.each([
    ['90ct Vitamin C',              90],
    ['90 count capsules',           90],
    ['30ct',                        30],
    ['60 capsules daily',           60],
    ['120 caps',                    120],
    ['200 tablets',                 200],
    ['30 tabs',                     30],
    ['60 softgels',                 60],
    ['90 gummies berry',            90],
    ['60 caplets',                  60],
    ['Brand X Shampoo 8oz',         null],   // size, not supplement count
    ['Brand X 2-pack',              null],   // pack, not supplement count
    ['plain product name',          null],
  ])('"%s" → %s', (text, expected) => {
    expect(extractCount(text)).toBe(expected);
  });
});

// ─── extractPackMultiplier ────────────────────────────────────────────────────

describe('extractPackMultiplier', () => {
  it.each([
    ['2-pack shampoo',              2],
    ['3pk',                         3],
    ['pack of 4',                   4],
    ['bundle of 6',                 6],
    ['set of 2',                    2],
    ['twin pack',                   2],
    ['triple pack',                 3],
    ['single bottle',               1],
    ['90ct vitamins',               null],   // supplement count, not pack
    ['plain product name',          null],
    ['8oz shampoo',                 null],
  ])('"%s" → %s', (text, expected) => {
    expect(extractPackMultiplier(text)).toBe(expected);
  });
});

// ─── extractVolumeSize ───────────────────────────────────────────────────────

describe('extractVolumeSize', () => {
  it.each([
    ['8 fl oz shampoo',             { value: 8,    unit: 'oz' }],
    ['12oz body wash',              { value: 12,   unit: 'oz' }],
    ['250ml serum',                 { value: 250,  unit: 'ml' }],
    ['100 ml toner',                { value: 100,  unit: 'ml' }],
    ['30g cream',                   { value: 30,   unit: 'g'  }],
    ['500 grams powder',            { value: 500,  unit: 'g'  }],
    ['500mg vitamin C 90ct',        null],              // mg is strength, not volume
    ['90ct capsules',               null],              // supplement count
    ['2-pack shampoo',              null],              // pack only
    ['plain product',               null],
  ])('"%s" → %p', (text, expected) => {
    expect(extractVolumeSize(text)).toEqual(expected);
  });
});

// ─── extractStrength ─────────────────────────────────────────────────────────

describe('extractStrength', () => {
  it.each([
    ['Vitamin C 500mg 90ct',        { value: 500,  unit: 'mg'  }],
    ['1000 mg daily',               { value: 1000, unit: 'mg'  }],
    ['Vitamin B12 1000mcg',         { value: 1000, unit: 'mcg' }],
    ['B12 500 mcg sublingual',      { value: 500,  unit: 'mcg' }],
    ['Vitamin D3 2000 IU',          { value: 2000, unit: 'iu'  }],
    ['D3 5000 i.u.',                { value: 5000, unit: 'iu'  }],
    ['Zinc 1% ointment',            { value: 1,    unit: '%'   }],
    ['plain supplement',            null],
    ['8oz shampoo',                 null],
  ])('"%s" → %p', (text, expected) => {
    expect(extractStrength(text)).toEqual(expected);
  });

  it('prefers mcg over mg when both present', () => {
    // "1000mcg" should not match as "mg" — mcg comes first in text
    const result = extractStrength('B12 1000mcg');
    expect(result?.unit).toBe('mcg');
    expect(result?.value).toBe(1000);
  });
});

// ─── extractCfuBillions ───────────────────────────────────────────────────────

describe('extractCfuBillions', () => {
  it.each([
    ['10 Billion CFU Probiotic',    10],
    ['50B CFU',                     50],
    ['25 billion live cultures',    25],
    ['100 Billion probiotic',       100],
    ['plain probiotic',             null],
    ['500mg vitamin',               null],
  ])('"%s" → %s', (text, expected) => {
    expect(extractCfuBillions(text)).toBe(expected);
  });
});

// ─── extractModelNumber ──────────────────────────────────────────────────────

describe('extractModelNumber', () => {
  it.each([
    ['Widget Model# ABC-123',       'ABC-123'],
    ['Part# XR500',                 'XR500'],
    ['SKU BE-1234',                 'BE-1234'],
    ['Item #ZX9000',                'ZX9000'],
    ['plain product name',          null],
    ['Vitamin C 500mg',             null],
  ])('"%s" → %s', (text, expected) => {
    expect(extractModelNumber(text)).toBe(expected);
  });
});

// ─── strictMatchIdentity — acceptance tests ──────────────────────────────────

describe('strictMatchIdentity', () => {

  // ── Count mismatches ────────────────────────────────────────────────────────

  it('90ct query vs 30ct comp → COUNT_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Brand X Vitamin C 90ct'), 'Brand X Vitamin C 30ct');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('COUNT_MISMATCH');
  });

  it('90ct query vs 60ct comp → COUNT_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Zinc 90 capsules'), 'Zinc 60 capsules');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('COUNT_MISMATCH');
  });

  it('90ct query vs no-count comp → PASS (benefit of doubt)', () => {
    const r = strictMatchIdentity(extractIdentity('Brand X Vitamin C 90ct'), 'Brand X Vitamin C');
    expect(r.pass).toBe(true);
    expect(r.rejectionReasons).toHaveLength(0);
  });

  it('90ct query vs 90ct comp → PASS', () => {
    const r = strictMatchIdentity(extractIdentity('Vitamin C 90ct'), 'Vitamin C 90 count');
    expect(r.pass).toBe(true);
  });

  // ── Pack multiplier mismatches ──────────────────────────────────────────────

  it('2-pack query vs single comp → PACK_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Brand X 2-pack shampoo'), 'Brand X single shampoo');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('PACK_MISMATCH');
  });

  it('3-pack query vs 2-pack comp → PACK_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Brand X 3-pack'), 'Brand X 2-pack');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('PACK_MISMATCH');
  });

  it('2-pack query vs no-pack comp → PASS (benefit of doubt)', () => {
    // Comp doesn't mention pack → null → benefit of doubt
    const r = strictMatchIdentity(extractIdentity('Shampoo 2-pack 8oz'), 'Shampoo 8oz');
    expect(r.pass).toBe(true);
  });

  // ── Size mismatches ─────────────────────────────────────────────────────────

  it('8oz query vs 12oz comp → SIZE_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Shampoo 8oz'), 'Shampoo 12oz');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('SIZE_MISMATCH');
  });

  it('250ml query vs 100ml comp → SIZE_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Serum 250ml'), 'Serum 100ml');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('SIZE_MISMATCH');
  });

  it('8oz query vs 8oz comp → PASS', () => {
    const r = strictMatchIdentity(extractIdentity('Shampoo 8oz'), 'Shampoo 8 oz daily');
    expect(r.pass).toBe(true);
  });

  it('8oz query vs no-size comp → PASS (benefit of doubt)', () => {
    const r = strictMatchIdentity(extractIdentity('Shampoo 8oz'), 'Shampoo moisturizing');
    expect(r.pass).toBe(true);
  });

  it('different units (oz vs ml) → SIZE_MISMATCH', () => {
    // Same-unit required in v1 — no conversion
    const r = strictMatchIdentity(extractIdentity('Shampoo 8oz'), 'Shampoo 250ml');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('SIZE_MISMATCH');
  });

  // ── Strength mismatches ─────────────────────────────────────────────────────

  it('500mg query vs 250mg comp → STRENGTH_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Vitamin C 500mg 90ct'), 'Vitamin C 250mg 90ct');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('STRENGTH_MISMATCH');
  });

  it('1000mcg vs 500mcg → STRENGTH_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('B12 1000mcg 60ct'), 'B12 500mcg 60ct');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('STRENGTH_MISMATCH');
  });

  it('500mg query vs no-strength comp → PASS (benefit of doubt)', () => {
    const r = strictMatchIdentity(extractIdentity('Vitamin C 500mg'), 'Vitamin C supplement');
    expect(r.pass).toBe(true);
  });

  it('500mg vs 500mg → PASS', () => {
    const r = strictMatchIdentity(extractIdentity('Vitamin C 500mg 90ct'), 'Vitamin C 500 mg 90 count');
    expect(r.pass).toBe(true);
  });

  it('different units (mg vs mcg) → STRENGTH_MISMATCH', () => {
    // Same-unit required
    const r = strictMatchIdentity(extractIdentity('B12 500mg'), 'B12 500mcg');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('STRENGTH_MISMATCH');
  });

  // ── CFU mismatches ──────────────────────────────────────────────────────────

  it('50B CFU query vs 10B CFU comp → CFU_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Probiotic 50 Billion CFU'), 'Probiotic 10 Billion CFU');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('CFU_MISMATCH');
  });

  it('10B CFU query vs 10B CFU comp → PASS (within tolerance)', () => {
    const r = strictMatchIdentity(extractIdentity('Probiotic 10 Billion CFU 30ct'), 'Probiotic 10B CFU 30 caps');
    expect(r.pass).toBe(true);
  });

  it('50B CFU query vs no-CFU comp → PASS (benefit of doubt)', () => {
    const r = strictMatchIdentity(extractIdentity('Probiotic 50 Billion CFU'), 'Probiotic supplement 30ct');
    expect(r.pass).toBe(true);
  });

  // ── Model number mismatches ─────────────────────────────────────────────────

  it('Model# ABC-123 query vs comp without model → MODEL_MISMATCH', () => {
    const r = strictMatchIdentity(extractIdentity('Widget Model# ABC-123'), 'Widget Blue 50w');
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('MODEL_MISMATCH');
  });

  it('Model# ABC-123 query vs comp containing ABC-123 → PASS', () => {
    const r = strictMatchIdentity(extractIdentity('Widget Model# ABC-123'), 'Widget ABC-123 50w Blue');
    expect(r.pass).toBe(true);
  });

  // ── No identity signals → never false-positive ─────────────────────────────

  it('no variant signals in query → always PASS', () => {
    const r = strictMatchIdentity(extractIdentity('Brand X Shampoo'), 'Brand X Shampoo 2-pack 500mg');
    expect(r.pass).toBe(true);
  });

  // ── Multiple mismatches reported ────────────────────────────────────────────

  it('count AND strength both wrong → both reasons reported', () => {
    const r = strictMatchIdentity(
      extractIdentity('Vitamin C 500mg 90ct'),
      'Vitamin C 250mg 30ct',
    );
    expect(r.pass).toBe(false);
    expect(r.rejectionReasons).toContain('COUNT_MISMATCH');
    expect(r.rejectionReasons).toContain('STRENGTH_MISMATCH');
  });
});
