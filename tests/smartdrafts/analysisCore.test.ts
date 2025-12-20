import { jest } from '@jest/globals';
import type { runSmartDraftScan as RunSmartDraftScanFn, SmartDraftScanResponse } from '../../src/lib/smartdrafts-scan-core.js';

const mockRunSmartDraftScan: jest.MockedFunction<typeof RunSmartDraftScanFn> = jest.fn();

const makeScanResponse = (bodyOverrides: Partial<SmartDraftScanResponse['body']> = {}): SmartDraftScanResponse => ({
  status: 200,
  body: {
    ok: true,
    folder: '/Photos',
    signature: 'sig-123',
    cached: false,
    count: 2,
    groups: [{ id: 'g1' }, { id: 'g2' }],
    imageInsights: { 'a.jpg': { url: 'a.jpg', role: 'front' } },
    warnings: ['w1'],
    ...bodyOverrides,
  },
});

jest.mock('../../src/lib/smartdrafts-scan-core.js', () => ({
  runSmartDraftScan: mockRunSmartDraftScan,
}));

import { runSmartdraftsAnalysis } from '../../src/smartdrafts/analysisCore.js';

describe('runSmartdraftsAnalysis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseOk = makeScanResponse();

  it('passes folder when no stagedUrls', async () => {
    mockRunSmartDraftScan.mockResolvedValue(baseOk);

    await runSmartdraftsAnalysis('/Photos', {}, 'user-1');

    expect(mockRunSmartDraftScan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', folder: '/Photos', stagedUrls: undefined, force: false, skipQuota: false })
    );
  });

  it('passes stagedUrls and omits folder', async () => {
    mockRunSmartDraftScan.mockResolvedValue(baseOk);
    const staged = ['https://cdn/a.jpg', 'https://cdn/b.jpg'];

    await runSmartdraftsAnalysis('/ShouldBeIgnored', {}, 'user-2', staged, true);

    expect(mockRunSmartDraftScan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-2', folder: undefined, stagedUrls: staged, skipQuota: true })
    );
  });

  it('maps forceRescan override to force flag', async () => {
    mockRunSmartDraftScan.mockResolvedValue(baseOk);

    await runSmartdraftsAnalysis('/Photos', { forceRescan: true }, 'user-3');

    expect(mockRunSmartDraftScan).toHaveBeenCalledWith(
      expect.objectContaining({ force: true })
    );
  });

  it('returns mapped AnalysisResult on success', async () => {
    mockRunSmartDraftScan.mockResolvedValue(baseOk);

    const result = await runSmartdraftsAnalysis('/Photos', {}, 'user-4');

    expect(result.folder).toBe('/Photos');
    expect(result.jobId).toBe('sig-123');
    expect(result.cached).toBe(false);
    expect(result.imageCount).toBe(2);
    expect(result.groups.length).toBe(2);
    expect(result.imageInsights).toEqual(baseOk.body.imageInsights);
    expect(result.warnings).toEqual(['w1']);
    expect(result.signature).toBe('sig-123');
  });

  it('falls back to groups length when count missing', async () => {
    const withoutCount = makeScanResponse({ count: undefined });
    mockRunSmartDraftScan.mockResolvedValue(withoutCount);

    const result = await runSmartdraftsAnalysis('/Photos', {}, 'user-5');

    expect(result.imageCount).toBe(2);
  });

  it('uses default jobId when signature missing', async () => {
    const noSig = makeScanResponse({ signature: null });
    mockRunSmartDraftScan.mockResolvedValue(noSig);

    const result = await runSmartdraftsAnalysis('/Photos', {}, 'user-6');

    expect(result.jobId).toBe('no-signature');
  });

  it('throws when scan returns ok=false', async () => {
    mockRunSmartDraftScan.mockResolvedValue({ status: 400, body: { ok: false, error: 'boom' } });

    await expect(runSmartdraftsAnalysis('/Photos', {}, 'user-7')).rejects.toThrow('boom');
  });
});
