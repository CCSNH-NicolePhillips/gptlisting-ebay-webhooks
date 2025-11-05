import { urlKey } from './urlKey.js';

export async function mockLoadAnalysis() {
  // Minimal, but matches your real fields
  return {
    groups: [],
    imageInsights: [
      { url: 'EBAY/awef.jpg',      role: 'front', roleScore: -1.05, hasVisibleText: true, dominantColor: 'black', evidenceTriggers: ['hero logo','product name'], visualDescription: 'black pouch front' },
      { url: 'EBAY/awefawed.jpg',  role: 'back',  roleScore:  1.55, hasVisibleText: true, dominantColor: 'black', evidenceTriggers: ['Supplement Facts','barcode'], visualDescription: 'black pouch back' },
      { url: 'EBAY/frog_01.jpg',   role: 'front', roleScore: -1.05, hasVisibleText: true, dominantColor: 'forest-green', evidenceTriggers: ['hero logo'], visualDescription: 'greens front' },
      { url: 'faeewfaw.jpg',       role: 'back',  roleScore:  1.75, hasVisibleText: true, dominantColor: 'dark-forest-green', evidenceTriggers: ['Supplement Facts'], visualDescription: 'greens back' },
    ]
  };
}

export async function mockRunPairing() {
  const pairing = {
    pairs: [
      { frontUrl: 'EBAY/awef.jpg', backUrl: 'EBAY/awefawed.jpg', matchScore: 8.0, confidence: 0.95, brand: 'myBrainCo.', product: 'Gut Repair', variant: 'Natural Berry', sizeFront: '310g', sizeBack: '310g', evidence: ['productNameSimilarity: 1.00','categoryCompat: +1.50','packagingMatch: pouch'] },
      { frontUrl: 'EBAY/frog_01.jpg', backUrl: 'faeewfaw.jpg', matchScore: 6.0, confidence: 0.90, brand: 'Frog Fuel', product: 'Performance Greens + Protein', variant: 'Lemon Lime', sizeFront: '720g', sizeBack: '720g', evidence: ['productNameSimilarity: 0.80','categoryCompat: +1.50','packagingMatch: pouch'] },
    ],
    singletons: [],
    products: [
      { productId: 'gut-repair-berry', brand: 'myBrainCo.', product: 'Gut Repair', variant: 'Natural Berry', size: '310g', categoryPath: 'Health & Wellness > Supplements', frontUrl: 'EBAY/awef.jpg', backUrl: 'EBAY/awefawed.jpg', extras: [], evidence: ['paired: score 8.0'] },
      { productId: 'frog-greens-lemon', brand: 'Frog Fuel', product: 'Performance Greens + Protein', variant: 'Lemon Lime', size: '720g', categoryPath: 'Health & Wellness > Supplements', frontUrl: 'EBAY/frog_01.jpg', backUrl: 'faeewfaw.jpg', extras: [], evidence: ['paired: score 6.0'] },
    ],
    debugSummary: [
      'front=EBAY/awef.jpg candidate=EBAY/awefawed.jpg matchScore=8.00',
      'front=EBAY/frog_01.jpg candidate=faeewfaw.jpg matchScore=6.00'
    ]
  };

  const metrics = {
    totals: { images: 4, fronts: 2, backs: 2, pairs: 2, singletons: 0, products: 2 },
    thresholds: { minPreScore: 1.5, autoPair: { score: 3.0, gap: 1.0 }, autoPairHair: { score: 2.4, gap: 0.8 } }
  };

  return { pairing, metrics };
}
