import { normalizeJobStatus, type JobStatus } from '../../../src/lib/jobs/job-status.js';

describe('normalizeJobStatus', () => {
  // ---- New `status` field (canonical values) ----

  it('passes through status:pending unchanged', () => {
    expect(normalizeJobStatus({ status: 'pending' })).toBe<JobStatus>('pending');
  });

  it('passes through status:processing unchanged', () => {
    expect(normalizeJobStatus({ status: 'processing' })).toBe<JobStatus>('processing');
  });

  it('passes through status:completed unchanged', () => {
    expect(normalizeJobStatus({ status: 'completed' })).toBe<JobStatus>('completed');
  });

  it('passes through status:failed unchanged', () => {
    expect(normalizeJobStatus({ status: 'failed' })).toBe<JobStatus>('failed');
  });

  // ---- Domain-specific intermediate values (quick-list) ----

  it('maps intermediate status:pairing to processing', () => {
    expect(normalizeJobStatus({ status: 'pairing' })).toBe<JobStatus>('processing');
  });

  it('maps intermediate status:creating-drafts to processing', () => {
    expect(normalizeJobStatus({ status: 'creating-drafts' })).toBe<JobStatus>('processing');
  });

  // ---- Legacy `state` field (scan / analyze-images / create-drafts pipelines) ----

  it('maps legacy state:pending to pending', () => {
    expect(normalizeJobStatus({ state: 'pending' })).toBe<JobStatus>('pending');
  });

  it('maps legacy state:running to processing', () => {
    expect(normalizeJobStatus({ state: 'running' })).toBe<JobStatus>('processing');
  });

  it('maps legacy state:complete to completed', () => {
    expect(normalizeJobStatus({ state: 'complete' })).toBe<JobStatus>('completed');
  });

  it('maps legacy state:completed to completed', () => {
    expect(normalizeJobStatus({ state: 'completed' })).toBe<JobStatus>('completed');
  });

  it('maps legacy state:error to failed', () => {
    expect(normalizeJobStatus({ state: 'error' })).toBe<JobStatus>('failed');
  });

  it('maps legacy state:failed to failed', () => {
    expect(normalizeJobStatus({ state: 'failed' })).toBe<JobStatus>('failed');
  });

  // ---- Priority: status field wins over state field ----

  it('status field takes priority over state field', () => {
    // New status should be used, old state is ignored
    expect(normalizeJobStatus({ status: 'completed', state: 'error' })).toBe<JobStatus>('completed');
  });

  it('status completed beats state error', () => {
    expect(normalizeJobStatus({ status: 'completed', state: 'running' })).toBe<JobStatus>('completed');
  });

  // ---- Edge cases ----

  it('defaults to pending when both fields are missing', () => {
    expect(normalizeJobStatus({})).toBe<JobStatus>('pending');
  });

  it('defaults to pending for unknown state string', () => {
    expect(normalizeJobStatus({ state: 'weird-value' })).toBe<JobStatus>('pending');
  });

  it('handles empty string status gracefully (falls through to state)', () => {
    // Empty string is falsy so status: '' should fall through
    expect(normalizeJobStatus({ status: '', state: 'complete' })).toBe<JobStatus>('completed');
  });
});
