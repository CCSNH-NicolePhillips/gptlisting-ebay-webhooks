import { buildMetrics, formatMetricsLog } from '../../src/pairing/metrics.js';

describe('buildMetrics', () => {
  const thresholds = {
    minPreScore: 0.2,
    autoPairScore: 2.4,
    autoPairGap: 0.8,
    autoPairHairScore: 2.1,
    autoPairHairGap: 0.7,
  };

  const makeFeature = (url: string, role: string, brandNorm?: string) => ({ url, role, brandNorm });

  it('aggregates totals, byBrand, reasons, and thresholds', () => {
    const features = new Map<string, any>([
      ['f1', makeFeature('https://img/front-a.jpg', 'front', 'Alpha')],
      ['f2', makeFeature('https://img/front-b.jpg', 'front', 'Beta')],
      ['b1', makeFeature('https://img/back-a.jpg', 'back', 'Alpha')],
      ['o1', makeFeature('https://img/other.jpg', 'other', 'Gamma')],
    ]);

    const candidatesMap = {
      'https://img/front-a.jpg': ['https://img/back-a.jpg'],
      'https://img/front-b.jpg': ['https://img/back-b.jpg', 'https://img/back-c.jpg'],
    };

    const autoPairs = [{ frontUrl: 'https://img/front-a.jpg', backUrl: 'https://img/back-a.jpg' }];
    const modelPairs = [{ frontUrl: 'https://img/FRONT-b.jpg', backUrl: 'https://img/back-b.jpg' }];
    const globalPairs = [{ frontUrl: 'https://img/front-c.jpg', backUrl: 'https://img/back-c.jpg' }];

    const singletons = [
      { url: 'https://img/front-d.jpg', reason: 'declined despite candidates: scores=[1.9,1.2]' },
      { url: 'https://img/front-e.jpg', reason: 'no candidates' },
      { url: 'https://img/front-f.jpg', reason: 'something else' },
    ];

    const metrics = buildMetrics({
      features,
      candidatesMap,
      autoPairs,
      modelPairs,
      globalPairs,
      singletons,
      thresholds,
      durationMs: 1234,
    });

    expect(metrics.totals).toEqual({
      images: 4,
      fronts: 2,
      backs: 2,
      candidates: 3,
      autoPairs: 1,
      modelPairs: 1,
      globalPairs: 1,
      singletons: 3,
    });

    expect(metrics.byBrand).toEqual({
      Alpha: { fronts: 1, paired: 1, pairRate: 1 },
      Beta: { fronts: 1, paired: 1, pairRate: 1 },
    });

    expect(metrics.reasons).toEqual({
      declined_despite_candidates: 1,
      no_candidates: 1,
      other: 1,
    });

    expect(metrics.thresholds).toEqual(thresholds);
    expect(metrics.durationMs).toBe(1234);
    expect(typeof metrics.timestamp).toBe('string');
  });
});

describe('formatMetricsLog', () => {
  it('formats a concise metrics summary', () => {
    const metrics = buildMetrics({
      features: new Map([
        ['f', { role: 'front', url: 'f' }],
        ['b', { role: 'back', url: 'b' }],
      ]),
      candidatesMap: {},
      autoPairs: [],
      modelPairs: [],
      singletons: [],
      thresholds: {
        minPreScore: 0,
        autoPairScore: 0,
        autoPairGap: 0,
        autoPairHairScore: 0,
        autoPairHairGap: 0,
      },
      durationMs: 10,
    });

    const log = formatMetricsLog(metrics);
    expect(log).toBe('METRICS images=2 fronts=1 backs=1 candidates=0 autoPairs=0 modelPairs=0 globalPairs=0 singletons=0');
  });
});
