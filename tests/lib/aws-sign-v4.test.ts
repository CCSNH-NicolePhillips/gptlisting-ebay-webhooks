import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import crypto from 'crypto';
import { signAwsRequest, type SigV4Config, type SigV4RequestParams } from '../../src/lib/aws-sign-v4.js';

describe('aws-sign-v4.ts', () => {
  let mockDate: Date;

  beforeEach(() => {
    // Mock Date to ensure consistent timestamps
    mockDate = new Date('2024-01-15T12:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createConfig = (): SigV4Config => ({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'execute-api',
    host: 'api.example.com',
  });

  const createParams = (): SigV4RequestParams => ({
    method: 'POST',
    path: '/v1/endpoint',
    body: JSON.stringify({ test: 'data' }),
  });

  describe('signAwsRequest', () => {
    it('should return signed request with all required fields', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('headers');
      expect(result).toHaveProperty('body');
    });

    it('should generate correct URL', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.url).toBe('https://api.example.com/v1/endpoint');
    });

    it('should include all required headers', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers).toHaveProperty('Content-Encoding');
      expect(result.headers).toHaveProperty('Content-Type');
      expect(result.headers).toHaveProperty('Host');
      expect(result.headers).toHaveProperty('X-Amz-Date');
      expect(result.headers).toHaveProperty('Authorization');
    });

    it('should set Content-Encoding to amz-1.0', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Content-Encoding']).toBe('amz-1.0');
    });

    it('should set Content-Type to application/json with charset', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Content-Type']).toBe('application/json; charset=utf-8');
    });

    it('should set Host header to config host', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Host']).toBe('api.example.com');
    });

    it('should generate X-Amz-Date in correct format', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      // Should be in format: YYYYMMDDTHHmmssZ
      expect(result.headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
      expect(result.headers['X-Amz-Date']).toBe('20240115T120000Z');
    });

    it('should generate Authorization header with AWS4-HMAC-SHA256', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Authorization']).toContain('AWS4-HMAC-SHA256');
    });

    it('should include access key ID in Authorization header', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Authorization']).toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('should include credential scope in Authorization header', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      // Credential scope: dateStamp/region/service/aws4_request
      expect(result.headers['Authorization']).toContain('20240115/us-east-1/execute-api/aws4_request');
    });

    it('should include signed headers in Authorization header', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Authorization']).toContain('SignedHeaders=content-encoding;content-type;host;x-amz-date');
    });

    it('should include signature in Authorization header', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Authorization']).toContain('Signature=');
      // Signature should be a hex string
      const signature = result.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];
      expect(signature).toBeDefined();
      expect(signature).toMatch(/^[a-f0-9]+$/);
    });

    it('should return original body', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.body).toBe(params.body);
    });

    it('should generate different signatures for different bodies', () => {
      const config = createConfig();
      const params1 = { method: 'POST' as const, path: '/v1/endpoint', body: JSON.stringify({ test: 'data1' }) };
      const params2 = { method: 'POST' as const, path: '/v1/endpoint', body: JSON.stringify({ test: 'data2' }) };

      const result1 = signAwsRequest(config, params1);
      const result2 = signAwsRequest(config, params2);

      const sig1 = result1.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];
      const sig2 = result2.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];

      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different paths', () => {
      const config = createConfig();
      const params1 = { method: 'POST' as const, path: '/v1/endpoint1', body: JSON.stringify({ test: 'data' }) };
      const params2 = { method: 'POST' as const, path: '/v1/endpoint2', body: JSON.stringify({ test: 'data' }) };

      const result1 = signAwsRequest(config, params1);
      const result2 = signAwsRequest(config, params2);

      const sig1 = result1.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];
      const sig2 = result2.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];

      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different regions', () => {
      const config1 = { ...createConfig(), region: 'us-east-1' };
      const config2 = { ...createConfig(), region: 'us-west-2' };
      const params = createParams();

      const result1 = signAwsRequest(config1, params);
      const result2 = signAwsRequest(config2, params);

      const sig1 = result1.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];
      const sig2 = result2.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];

      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different services', () => {
      const config1 = { ...createConfig(), service: 'execute-api' };
      const config2 = { ...createConfig(), service: 's3' };
      const params = createParams();

      const result1 = signAwsRequest(config1, params);
      const result2 = signAwsRequest(config2, params);

      const sig1 = result1.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];
      const sig2 = result2.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];

      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different secret keys', () => {
      const config1 = { ...createConfig(), secretAccessKey: 'secret1' };
      const config2 = { ...createConfig(), secretAccessKey: 'secret2' };
      const params = createParams();

      const result1 = signAwsRequest(config1, params);
      const result2 = signAwsRequest(config2, params);

      const sig1 = result1.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];
      const sig2 = result2.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];

      expect(sig1).not.toBe(sig2);
    });

    it('should handle empty body', () => {
      const config = createConfig();
      const params = { method: 'POST' as const, path: '/v1/endpoint', body: '' };

      const result = signAwsRequest(config, params);

      expect(result.body).toBe('');
      expect(result.headers['Authorization']).toBeDefined();
    });

    it('should handle complex JSON body', () => {
      const config = createConfig();
      const complexBody = JSON.stringify({
        nested: {
          array: [1, 2, 3],
          object: { key: 'value' }
        },
        string: 'test',
        number: 123,
        boolean: true
      });
      const params = { method: 'POST' as const, path: '/v1/endpoint', body: complexBody };

      const result = signAwsRequest(config, params);

      expect(result.body).toBe(complexBody);
      expect(result.headers['Authorization']).toBeDefined();
    });

    it('should handle path with query parameters', () => {
      const config = createConfig();
      const params = { method: 'POST' as const, path: '/v1/endpoint?param=value', body: '{}' };

      const result = signAwsRequest(config, params);

      expect(result.url).toBe('https://api.example.com/v1/endpoint?param=value');
    });

    it('should handle different hosts', () => {
      const config1 = { ...createConfig(), host: 'api1.example.com' };
      const config2 = { ...createConfig(), host: 'api2.example.com' };
      const params = createParams();

      const result1 = signAwsRequest(config1, params);
      const result2 = signAwsRequest(config2, params);

      expect(result1.url).toContain('api1.example.com');
      expect(result2.url).toContain('api2.example.com');
      expect(result1.headers['Host']).toBe('api1.example.com');
      expect(result2.headers['Host']).toBe('api2.example.com');
    });

    it('should generate consistent signature for same inputs', () => {
      const config = createConfig();
      const params = createParams();

      const result1 = signAwsRequest(config, params);
      const result2 = signAwsRequest(config, params);

      expect(result1.headers['Authorization']).toBe(result2.headers['Authorization']);
    });

    it('should properly hash payload', () => {
      const config = createConfig();
      const body = JSON.stringify({ test: 'data' });
      const params = { method: 'POST' as const, path: '/v1/endpoint', body };

      const result = signAwsRequest(config, params);

      // The signature should be based on the SHA256 hash of the body
      const expectedHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
      
      // We can't directly verify the hash in the signature, but we can verify
      // that changing the body changes the signature
      const params2 = { ...params, body: JSON.stringify({ test: 'different' }) };
      const result2 = signAwsRequest(config, params2);

      const sig1 = result.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];
      const sig2 = result2.headers['Authorization'].match(/Signature=([a-f0-9]+)/)?.[1];

      expect(sig1).not.toBe(sig2);
    });

    it('should use correct signing algorithm', () => {
      const config = createConfig();
      const params = createParams();

      const result = signAwsRequest(config, params);

      expect(result.headers['Authorization'].startsWith('AWS4-HMAC-SHA256')).toBe(true);
    });

    it('should format credential scope correctly', () => {
      const config = { ...createConfig(), region: 'eu-west-1', service: 's3' };
      const params = createParams();

      const result = signAwsRequest(config, params);

      // Format: YYYYMMDD/region/service/aws4_request
      expect(result.headers['Authorization']).toContain('20240115/eu-west-1/s3/aws4_request');
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters in body', () => {
      const config = createConfig();
      const body = JSON.stringify({ text: 'Special chars: éñ中文🎉' });
      const params = { method: 'POST' as const, path: '/v1/endpoint', body };

      const result = signAwsRequest(config, params);

      expect(result.body).toBe(body);
      expect(result.headers['Authorization']).toBeDefined();
    });

    it('should handle long paths', () => {
      const config = createConfig();
      const longPath = '/v1/very/long/path/with/many/segments/to/test/signing';
      const params = { method: 'POST' as const, path: longPath, body: '{}' };

      const result = signAwsRequest(config, params);

      expect(result.url).toContain(longPath);
    });

    it('should handle large payloads', () => {
      const config = createConfig();
      const largeBody = JSON.stringify({ data: 'x'.repeat(10000) });
      const params = { method: 'POST' as const, path: '/v1/endpoint', body: largeBody };

      const result = signAwsRequest(config, params);

      expect(result.body).toBe(largeBody);
      expect(result.headers['Authorization']).toBeDefined();
    });
  });
});
