describe('user-keys', () => {
  it('should generate job key', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.job('user123', 'job456');
    
    expect(key).toBe('job:user123:job456');
  });

  it('should generate price key', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.price('user123', 'job456', 'group789');
    
    expect(key).toBe('price:user123:job456:group789');
  });

  it('should generate override key', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.override('user123', 'job456', 'group789');
    
    expect(key).toBe('taxo:ovr:user123:job456:group789');
  });

  it('should generate jobsIdx key', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.jobsIdx('user123');
    
    expect(key).toBe('jobsidx:user123');
  });

  it('should generate settings key', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.settings('user123');
    
    expect(key).toBe('settings:user123');
  });

  it('should handle special characters in userId', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.job('user@email.com', 'job-id');
    
    expect(key).toBe('job:user@email.com:job-id');
  });

  it('should handle numeric IDs', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.price('123', '456', '789');
    
    expect(key).toBe('price:123:456:789');
  });

  it('should handle empty strings', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const key = k.job('', '');
    
    expect(key).toBe('job::');
  });

  it('should handle UUIDs', () => {
    const { k } = require('../../src/lib/user-keys');
    
    const userId = 'auth0|507f1f77bcf86cd799439011';
    const jobId = '550e8400-e29b-41d4-a716-446655440000';
    const key = k.job(userId, jobId);
    
    expect(key).toBe(`job:${userId}:${jobId}`);
  });
});
