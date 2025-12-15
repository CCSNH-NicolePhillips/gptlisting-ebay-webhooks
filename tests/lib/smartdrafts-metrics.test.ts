describe('smartdrafts-metrics', () => {
  describe('newMetrics', () => {
    it('should create metrics object with jobId', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('job123');

      expect(metrics).toEqual({ jobId: 'job123' });
    });

    it('should handle empty jobId', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('');

      expect(metrics).toEqual({ jobId: '' });
    });

    it('should handle UUID jobId', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      const metrics = newMetrics(jobId);

      expect(metrics.jobId).toBe(jobId);
    });

    it('should create object that can be extended with metrics', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('job123');
      metrics.imageCount = 10;
      metrics.visionMs = 5000;
      metrics.productCount = 3;

      expect(metrics).toEqual({
        jobId: 'job123',
        imageCount: 10,
        visionMs: 5000,
        productCount: 3,
      });
    });

    it('should not include optional fields by default', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('job123');

      expect(metrics).not.toHaveProperty('folder');
      expect(metrics).not.toHaveProperty('cached');
      expect(metrics).not.toHaveProperty('imageCount');
      expect(metrics).not.toHaveProperty('visionMs');
    });

    it('should allow setting timing metrics', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('job123');
      metrics.visionMs = 1500;
      metrics.totalScanMs = 5000;
      metrics.pairingMs = 2000;
      metrics.draftsMs = 800;

      expect(metrics.visionMs).toBe(1500);
      expect(metrics.totalScanMs).toBe(5000);
      expect(metrics.pairingMs).toBe(2000);
      expect(metrics.draftsMs).toBe(800);
    });

    it('should allow setting count metrics', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('job123');
      metrics.imageCount = 25;
      metrics.productCount = 5;
      metrics.pairCount = 20;
      metrics.singletonCount = 5;
      metrics.orphanImageCount = 0;

      expect(metrics.imageCount).toBe(25);
      expect(metrics.productCount).toBe(5);
      expect(metrics.pairCount).toBe(20);
      expect(metrics.singletonCount).toBe(5);
      expect(metrics.orphanImageCount).toBe(0);
    });

    it('should allow setting boolean flags', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('job123');
      metrics.cached = true;
      metrics.usedDownscale = false;

      expect(metrics.cached).toBe(true);
      expect(metrics.usedDownscale).toBe(false);
    });

    it('should allow setting folder and concurrency', () => {
      const { newMetrics } = require('../../src/lib/smartdrafts-metrics');
      
      const metrics = newMetrics('job123');
      metrics.folder = 'dropbox/products';
      metrics.visionConcurrency = 4;

      expect(metrics.folder).toBe('dropbox/products');
      expect(metrics.visionConcurrency).toBe(4);
    });
  });
});
