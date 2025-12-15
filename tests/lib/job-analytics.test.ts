/**
 * Tests for job-analytics.ts
 * Target: 100% code coverage
 */

import {
  fetchJobSummaries,
  fetchJobDetail,
  JobSummary,
  JobDetail,
  PriceStats,
} from '../../src/lib/job-analytics';

// Mock dependencies
jest.mock('../../src/lib/job-store', () => ({
  listJobs: jest.fn(),
  getJob: jest.fn(),
}));

jest.mock('../../src/lib/price-store', () => ({
  getBindingsForJob: jest.fn(),
}));

import { listJobs, getJob } from '../../src/lib/job-store';
import { getBindingsForJob } from '../../src/lib/price-store';

const mockListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockGetJob = getJob as jest.MockedFunction<typeof getJob>;
const mockGetBindingsForJob = getBindingsForJob as jest.MockedFunction<typeof getBindingsForJob>;

describe('job-analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchJobSummaries', () => {
    it('should fetch and summarize jobs', async () => {
      const mockJobs = [
        {
          jobId: 'job1',
          state: 'completed',
          createdAt: 1000,
          startedAt: 2000,
          finishedAt: 3000,
        },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].jobId).toBe('job1');
      expect(summaries[0].state).toBe('completed');
    });

    it('should use provided limit', async () => {
      mockListJobs.mockResolvedValue([]);
      mockGetBindingsForJob.mockResolvedValue([]);

      await fetchJobSummaries(10);

      expect(mockListJobs).toHaveBeenCalledWith(10);
    });

    it('should use default limit of 50', async () => {
      mockListJobs.mockResolvedValue([]);
      mockGetBindingsForJob.mockResolvedValue([]);

      await fetchJobSummaries();

      expect(mockListJobs).toHaveBeenCalledWith(50);
    });

    it('should sort jobs by lastUpdatedAt descending', async () => {
      const mockJobs = [
        { jobId: 'job1', finishedAt: 1000 },
        { jobId: 'job2', finishedAt: 3000 },
        { jobId: 'job3', finishedAt: 2000 },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].jobId).toBe('job2'); // 3000
      expect(summaries[1].jobId).toBe('job3'); // 2000
      expect(summaries[2].jobId).toBe('job1'); // 1000
    });

    it('should handle jobs with no timestamps', async () => {
      const mockJobs = [
        { jobId: 'job1' },
        { jobId: 'job2', finishedAt: 1000 },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].jobId).toBe('job2');
      expect(summaries[1].jobId).toBe('job1');
    });

    it('should calculate price stats from bindings', async () => {
      const mockJobs = [{ jobId: 'job1' }];
      const mockBindings = [
        { currentPrice: 10.5, auto: false },
        { currentPrice: 20.0, auto: true },
        { currentPrice: 15.25, auto: false },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue(mockBindings as any);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].price.average).toBe(15.25); // (10.5 + 20 + 15.25) / 3
      expect(summaries[0].price.min).toBe(10.5);
      expect(summaries[0].price.max).toBe(20);
      expect(summaries[0].price.bindingCount).toBe(3);
      expect(summaries[0].price.autoCount).toBe(1);
    });

    it('should parse job state', async () => {
      const mockJobs = [
        { jobId: 'job1', state: 'pending' },
        { jobId: 'job2', state: 'running' },
        { jobId: 'job3', state: 'completed' },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries.find(s => s.jobId === 'job1')?.state).toBe('pending');
      expect(summaries.find(s => s.jobId === 'job2')?.state).toBe('running');
      expect(summaries.find(s => s.jobId === 'job3')?.state).toBe('completed');
    });

    it('should default state to "unknown" when missing', async () => {
      const mockJobs = [{ jobId: 'job1' }];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].state).toBe('unknown');
    });

    it('should calculate duration from startedAt and finishedAt', async () => {
      const mockJobs = [
        { jobId: 'job1', startedAt: 1000, finishedAt: 3500 },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].durationMs).toBe(2500);
    });

    it('should return null duration when timestamps missing', async () => {
      const mockJobs = [
        { jobId: 'job1' },
        { jobId: 'job2', startedAt: 1000 },
        { jobId: 'job3', finishedAt: 2000 },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].durationMs).toBeNull();
      expect(summaries[1].durationMs).toBeNull();
      expect(summaries[2].durationMs).toBeNull();
    });

    it('should count warnings array', async () => {
      const mockJobs = [
        { jobId: 'job1', warnings: ['warn1', 'warn2', 'warn3'] },
        { jobId: 'job2', warnings: [] },
        { jobId: 'job3' },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries.find(s => s.jobId === 'job1')?.warningsCount).toBe(3);
      expect(summaries.find(s => s.jobId === 'job2')?.warningsCount).toBe(0);
      expect(summaries.find(s => s.jobId === 'job3')?.warningsCount).toBe(0);
    });

    it('should parse summary object', async () => {
      const mockJobs = [
        { jobId: 'job1', summary: { batches: 5, totalGroups: 20 } },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].summary).toEqual({ batches: 5, totalGroups: 20 });
    });

    it('should return null for invalid summary', async () => {
      const mockJobs = [
        { jobId: 'job1', summary: null },
        { jobId: 'job2', summary: 'invalid' },
        { jobId: 'job3', summary: {} },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].summary).toBeNull();
      expect(summaries[1].summary).toBeNull();
      expect(summaries[2].summary).toBeNull();
    });

    it('should extract jobId from key field if jobId missing', async () => {
      const mockJobs = [
        { key: 'job:abc123' },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].jobId).toBe('abc123');
    });

    it('should use "unknown" if jobId cannot be determined', async () => {
      const mockJobs = [
        { state: 'pending' },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].jobId).toBe('unknown');
    });

    it('should handle string timestamps', async () => {
      const mockJobs = [
        { jobId: 'job1', createdAt: '1000', startedAt: '2000', finishedAt: '3000' },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].createdAt).toBe(1000);
      expect(summaries[0].startedAt).toBe(2000);
      expect(summaries[0].finishedAt).toBe(3000);
    });

    it('should handle invalid timestamps', async () => {
      const mockJobs = [
        { jobId: 'job1', createdAt: 'invalid', startedAt: NaN, finishedAt: Infinity },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].createdAt).toBeNull();
      expect(summaries[0].startedAt).toBeNull();
      expect(summaries[0].finishedAt).toBeNull();
    });

    it('should filter out invalid prices', async () => {
      const mockJobs = [{ jobId: 'job1' }];
      const mockBindings = [
        { currentPrice: 10 },
        { currentPrice: 'invalid' },
        { currentPrice: NaN },
        { currentPrice: -5 },
        { currentPrice: 0 },
        { currentPrice: 20 },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue(mockBindings as any);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].price.sampleCount).toBe(2); // Only 10 and 20
      expect(summaries[0].price.average).toBe(15);
    });

    it('should return zero stats when no valid prices', async () => {
      const mockJobs = [{ jobId: 'job1' }];
      const mockBindings = [
        { currentPrice: 'invalid' },
        { currentPrice: 0 },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue(mockBindings as any);

      const summaries = await fetchJobSummaries();

      expect(summaries[0].price.average).toBe(0);
      expect(summaries[0].price.min).toBe(0);
      expect(summaries[0].price.max).toBe(0);
      expect(summaries[0].price.sampleCount).toBe(0);
    });

    it('should parse string info and error fields', async () => {
      const mockJobs = [
        { jobId: 'job1', info: 'Processing...', error: 'Failed' },
        { jobId: 'job2', info: '', error: '  ' },
      ];

      mockListJobs.mockResolvedValue(mockJobs);
      mockGetBindingsForJob.mockResolvedValue([]);

      const summaries = await fetchJobSummaries();

      expect(summaries.find(s => s.jobId === 'job1')?.info).toBe('Processing...');
      expect(summaries.find(s => s.jobId === 'job1')?.error).toBe('Failed');
      expect(summaries.find(s => s.jobId === 'job2')?.info).toBeNull();
      expect(summaries.find(s => s.jobId === 'job2')?.error).toBeNull();
    });
  });

  describe('fetchJobDetail', () => {
    it('should fetch and enrich job detail', async () => {
      const mockJob = {
        jobId: 'job1',
        state: 'completed',
        warnings: ['warn1'],
        groups: [{ groupId: 'g1', name: 'Group 1' }],
      };

      const mockBindings = [
        { groupId: 'g1', currentPrice: 10, auto: false },
      ];

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue(mockBindings as any);

      const detail = await fetchJobDetail('job1');

      expect(detail).not.toBeNull();
      expect(detail?.jobId).toBe('job1');
      expect(detail?.warnings).toEqual(['warn1']);
      expect(detail?.groups).toHaveLength(1);
      expect(detail?.bindings).toHaveLength(1);
    });

    it('should return null for empty jobId', async () => {
      const detail = await fetchJobDetail('');
      expect(detail).toBeNull();
    });

    it('should return null for whitespace-only jobId', async () => {
      const detail = await fetchJobDetail('   ');
      expect(detail).toBeNull();
    });

    it('should trim jobId before fetching', async () => {
      mockGetJob.mockResolvedValue(null);

      await fetchJobDetail('  job1  ');

      expect(mockGetJob).toHaveBeenCalledWith('job1');
    });

    it('should return null when job not found', async () => {
      mockGetJob.mockResolvedValue(null);

      const detail = await fetchJobDetail('nonexistent');

      expect(detail).toBeNull();
    });

    it('should enrich groups with bindings', async () => {
      const mockJob = {
        jobId: 'job1',
        groups: [
          { groupId: 'g1', name: 'Group 1' },
          { groupId: 'g2', name: 'Group 2' },
        ],
      };

      const mockBindings = [
        { groupId: 'g1', currentPrice: 10 },
        { groupId: 'g3', currentPrice: 20 },
      ];

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue(mockBindings as any);

      const detail = await fetchJobDetail('job1');

      expect(detail?.groups[0]).toHaveProperty('binding');
      expect(detail?.groups[0].binding).toEqual({ groupId: 'g1', currentPrice: 10 });
      expect(detail?.groups[1]).not.toHaveProperty('binding');
    });

    it('should handle empty groups array', async () => {
      const mockJob = {
        jobId: 'job1',
        groups: [],
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail?.groups).toEqual([]);
    });

    it('should handle missing groups field', async () => {
      const mockJob = {
        jobId: 'job1',
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail?.groups).toEqual([]);
    });

    it('should extract strings from warnings array', async () => {
      const mockJob = {
        jobId: 'job1',
        warnings: ['warn1', '  warn2  ', '', 123, null],
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail?.warnings).toEqual(['warn1', 'warn2', '123']);
    });

    it('should handle non-array warnings', async () => {
      const mockJob = {
        jobId: 'job1',
        warnings: 'not an array',
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail?.warnings).toEqual([]);
    });

    it('should handle non-object group items', async () => {
      const mockJob = {
        jobId: 'job1',
        groups: ['string', 123, null, { groupId: 'g1' }],
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail?.groups).toHaveLength(4);
      expect(detail?.groups[0]).toEqual({ value: 'string' });
      expect(detail?.groups[1]).toEqual({ value: 123 });
      expect(detail?.groups[2]).toEqual({ value: null });
      expect(detail?.groups[3]).toHaveProperty('groupId', 'g1');
    });

    it('should include all JobSummary fields', async () => {
      const mockJob = {
        jobId: 'job1',
        state: 'completed',
        info: 'Done',
        error: null,
        createdAt: 1000,
        startedAt: 2000,
        finishedAt: 3000,
        warnings: [],
        summary: { batches: 1, totalGroups: 5 },
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail).toMatchObject({
        jobId: 'job1',
        state: 'completed',
        info: 'Done',
        error: null,
        createdAt: 1000,
        startedAt: 2000,
        finishedAt: 3000,
        durationMs: 1000,
        warningsCount: 0,
        summary: { batches: 1, totalGroups: 5 },
        lastUpdatedAt: 3000,
      });
    });

    it('should round prices to 2 decimal places', async () => {
      const mockJob = { jobId: 'job1' };
      const mockBindings = [
        { currentPrice: 10.555, auto: false },
        { currentPrice: 20.444, auto: false },
      ];

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue(mockBindings as any);

      const detail = await fetchJobDetail('job1');

      expect(detail?.price.average).toBe(15.5); // (10.555 + 20.444) / 2 = 15.4995 -> 15.50
      expect(detail?.price.min).toBe(10.55); // Math.min rounds down
      expect(detail?.price.max).toBe(20.44);
    });

    it('should handle negative durations', async () => {
      const mockJob = {
        jobId: 'job1',
        startedAt: 3000,
        finishedAt: 1000, // Finished before started (invalid)
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail?.durationMs).toBeNull();
    });

    it('should handle fractional timestamps', async () => {
      const mockJob = {
        jobId: 'job1',
        createdAt: 1000.7,
        startedAt: 2000.3,
        finishedAt: 3000.9,
      };

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue([]);

      const detail = await fetchJobDetail('job1');

      expect(detail?.createdAt).toBe(1000);
      expect(detail?.startedAt).toBe(2000);
      expect(detail?.finishedAt).toBe(3000);
    });

    it('should preserve group properties when adding binding', async () => {
      const mockJob = {
        jobId: 'job1',
        groups: [
          { groupId: 'g1', name: 'Test', custom: 'value' },
        ],
      };

      const mockBindings = [
        { groupId: 'g1', currentPrice: 10 },
      ];

      mockGetJob.mockResolvedValue(mockJob);
      mockGetBindingsForJob.mockResolvedValue(mockBindings as any);

      const detail = await fetchJobDetail('job1');

      expect(detail?.groups[0]).toMatchObject({
        groupId: 'g1',
        name: 'Test',
        custom: 'value',
        binding: { groupId: 'g1', currentPrice: 10 },
      });
    });
  });
});
