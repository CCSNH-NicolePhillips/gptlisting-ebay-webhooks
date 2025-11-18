import { urlKey } from './urlKey.js';

export async function mockLoadAnalysis() {
  // Minimal, but matches your real fields
  // Using placeholder service for demo images
  return {
    groups: [],
    imageInsights: [
      { url: 'https://via.placeholder.com/400x600/1a1a1a/ffffff?text=Front+1', role: 'front', roleScore: -1.05, hasVisibleText: true, dominantColor: 'black', evidenceTriggers: ['hero logo','product name'], visualDescription: 'black pouch front' },
      { url: 'https://via.placeholder.com/400x600/1a1a1a/cccccc?text=Back+1', role: 'back',  roleScore:  1.55, hasVisibleText: true, dominantColor: 'black', evidenceTriggers: ['Supplement Facts','barcode'], visualDescription: 'black pouch back' },
      { url: 'https://via.placeholder.com/400x600/2d5016/ffffff?text=Front+2', role: 'front', roleScore: -1.05, hasVisibleText: true, dominantColor: 'forest-green', evidenceTriggers: ['hero logo'], visualDescription: 'greens front' },
      { url: 'https://via.placeholder.com/400x600/1a3d1a/cccccc?text=Back+2', role: 'back',  roleScore:  1.75, hasVisibleText: true, dominantColor: 'dark-forest-green', evidenceTriggers: ['Supplement Facts'], visualDescription: 'greens back' },
    ]
  };
}

export async function mockRunPairing() {
  const pairing = {
    pairs: [
      { frontUrl: 'https://via.placeholder.com/400x600/1a1a1a/ffffff?text=Front+1', backUrl: 'https://via.placeholder.com/400x600/1a1a1a/cccccc?text=Back+1', matchScore: 8.0, confidence: 0.95, brand: 'myBrainCo.', product: 'Gut Repair', variant: 'Natural Berry', sizeFront: '310g', sizeBack: '310g', evidence: ['productNameSimilarity: 1.00','categoryCompat: +1.50','packagingMatch: pouch'] },
      { frontUrl: 'https://via.placeholder.com/400x600/2d5016/ffffff?text=Front+2', backUrl: 'https://via.placeholder.com/400x600/1a3d1a/cccccc?text=Back+2', matchScore: 6.0, confidence: 0.90, brand: 'Frog Fuel', product: 'Performance Greens + Protein', variant: 'Lemon Lime', sizeFront: '720g', sizeBack: '720g', evidence: ['productNameSimilarity: 0.80','categoryCompat: +1.50','packagingMatch: pouch'] },
    ],
    singletons: [],
    products: [
      { productId: 'gut-repair-berry', brand: 'myBrainCo.', product: 'Gut Repair', variant: 'Natural Berry', size: '310g', categoryPath: 'Health & Wellness > Supplements', frontUrl: 'https://via.placeholder.com/400x600/1a1a1a/ffffff?text=Front+1', backUrl: 'https://via.placeholder.com/400x600/1a1a1a/cccccc?text=Back+1', extras: [], evidence: ['paired: score 8.0'] },
      { productId: 'frog-greens-lemon', brand: 'Frog Fuel', product: 'Performance Greens + Protein', variant: 'Lemon Lime', size: '720g', categoryPath: 'Health & Wellness > Supplements', frontUrl: 'https://via.placeholder.com/400x600/2d5016/ffffff?text=Front+2', backUrl: 'https://via.placeholder.com/400x600/1a3d1a/cccccc?text=Back+2', extras: [], evidence: ['paired: score 6.0'] },
    ],
    debugSummary: [
      'front=Front+1 candidate=Back+1 matchScore=8.00',
      'front=Front+2 candidate=Back+2 matchScore=6.00'
    ]
  };

  const metrics = {
    totals: { images: 4, fronts: 2, backs: 2, pairs: 2, singletons: 0, products: 2 },
    thresholds: { minPreScore: 1.5, autoPair: { score: 3.0, gap: 1.0 }, autoPairHair: { score: 2.4, gap: 0.8 } }
  };

  return { pairing, metrics };
}



