// Metrics and audit trail for pairing runs

export interface PairingMetrics {
  totals: {
    images: number;
    fronts: number;
    backs: number;
    candidates: number;
    autoPairs: number;
    modelPairs: number;
    singletons: number;
  };
  byBrand: Record<string, {
    fronts: number;
    paired: number;
    pairRate: number;
  }>;
  reasons: Record<string, number>;
  thresholds: {
    minPreScore: number;
    autoPairScore: number;
    autoPairGap: number;
    autoPairHairScore: number;
    autoPairHairGap: number;
  };
  timestamp: string;
  durationMs: number;
}

export function buildMetrics(opts: {
  features: Map<string, any>;
  candidatesMap: Record<string, any[]>;
  autoPairs: any[];
  modelPairs: any[];
  singletons: any[];
  thresholds: PairingMetrics['thresholds'];
  durationMs: number;
}): PairingMetrics {
  const { features, candidatesMap, autoPairs, modelPairs, singletons, thresholds, durationMs } = opts;
  
  const fronts = Array.from(features.values()).filter(f => f.role === 'front');
  const backs = Array.from(features.values()).filter(f => f.role === 'back' || f.role === 'other');
  
  // Total candidates across all fronts
  const totalCandidates = Object.values(candidatesMap).reduce((sum, c) => sum + c.length, 0);
  
  // By-brand breakdown
  const byBrand: Record<string, { fronts: number; paired: number; pairRate: number }> = {};
  const allPairs = [...autoPairs, ...modelPairs];
  
  for (const front of fronts) {
    const brand = front.brandNorm || 'Unknown';
    if (!byBrand[brand]) {
      byBrand[brand] = { fronts: 0, paired: 0, pairRate: 0 };
    }
    byBrand[brand].fronts++;
    
    const isPaired = allPairs.some(p => p.frontUrl.toLowerCase() === front.url.toLowerCase());
    if (isPaired) byBrand[brand].paired++;
  }
  
  // Calculate pair rates
  for (const brand in byBrand) {
    const b = byBrand[brand];
    b.pairRate = b.fronts > 0 ? Math.round((b.paired / b.fronts) * 100) / 100 : 0;
  }
  
  // Singleton/decline reasons histogram
  const reasons: Record<string, number> = {};
  for (const s of singletons) {
    const reasonKey = s.reason.startsWith('declined despite candidates') 
      ? 'declined_despite_candidates'
      : s.reason === 'no candidates'
      ? 'no_candidates'
      : 'other';
    reasons[reasonKey] = (reasons[reasonKey] || 0) + 1;
  }
  
  return {
    totals: {
      images: features.size,
      fronts: fronts.length,
      backs: backs.length,
      candidates: totalCandidates,
      autoPairs: autoPairs.length,
      modelPairs: modelPairs.length,
      singletons: singletons.length
    },
    byBrand,
    reasons,
    thresholds,
    timestamp: new Date().toISOString(),
    durationMs
  };
}

export function formatMetricsLog(m: PairingMetrics): string {
  return `METRICS images=${m.totals.images} fronts=${m.totals.fronts} backs=${m.totals.backs} candidates=${m.totals.candidates} autoPairs=${m.totals.autoPairs} modelPairs=${m.totals.modelPairs} singletons=${m.totals.singletons}`;
}
