/**
 * Unit tests for auth-admin.ts
 * Tests admin token authentication
 * 
 * Note: The module loads ADMIN_API_TOKEN once at import time,
 * so we test based on the actual environment when tests run.
 */

describe('auth-admin', () => {
  // Save original env
  const originalToken = process.env.ADMIN_API_TOKEN;
  
  // Clean up modules before each test to reload with new env
  beforeEach(() => {
    jest.resetModules();
  });

  afterAll(() => {
    // Restore original
    if (originalToken !== undefined) {
      process.env.ADMIN_API_TOKEN = originalToken;
    } else {
      delete process.env.ADMIN_API_TOKEN;
    }
  });

  describe('requireAdminAuth with no token configured', () => {
    beforeEach(() => {
      delete process.env.ADMIN_API_TOKEN;
    });

    it('should pass when no admin token is configured', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      // Should not throw when no token configured
      expect(() => requireAdminAuth()).not.toThrow();
      expect(() => requireAdminAuth('invalid')).not.toThrow();
      expect(() => requireAdminAuth('Bearer wrong')).not.toThrow();
    });

    it('should pass with any header when no token configured', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('anything')).not.toThrow();
      expect(() => requireAdminAuth('')).not.toThrow();
    });
  });

  describe('requireAdminAuth with token configured', () => {
    beforeEach(() => {
      process.env.ADMIN_API_TOKEN = 'test-secret-token';
    });

    it('should pass with correct Bearer token', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('Bearer test-secret-token')).not.toThrow();
    });

    it('should handle whitespace in auth header token', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      // Should trim token after Bearer
      expect(() => requireAdminAuth('Bearer   test-secret-token   ')).not.toThrow();
    });

    it('should throw when Bearer prefix is missing', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('test-secret-token')).toThrow('unauthorized');
    });

    it('should throw when authHeader is undefined', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth()).toThrow('unauthorized');
    });

    it('should throw when token does not match', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('Bearer wrong-token')).toThrow('unauthorized');
    });

    it('should throw when authHeader is empty', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('')).toThrow('unauthorized');
    });

    it('should reject partial Bearer prefix', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('Bear test-secret-token')).toThrow('unauthorized');
    });

    it('should reject case-sensitive Bearer', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('bearer test-secret-token')).toThrow('unauthorized');
    });

    it('should reject when only Bearer is provided', () => {
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      expect(() => requireAdminAuth('Bearer ')).toThrow('unauthorized');
    });
  });

  describe('requireAdminAuth with whitespace token', () => {
    it('should handle whitespace in environment token', () => {
      process.env.ADMIN_API_TOKEN = '  test-secret-token  ';
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      // Should trim env token and match
      expect(() => requireAdminAuth('Bearer test-secret-token')).not.toThrow();
    });

    it('should handle empty string token as no auth', () => {
      process.env.ADMIN_API_TOKEN = '';
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      // Empty token means no auth required
      expect(() => requireAdminAuth()).not.toThrow();
      expect(() => requireAdminAuth('Bearer anything')).not.toThrow();
    });

    it('should handle whitespace-only token as no auth', () => {
      process.env.ADMIN_API_TOKEN = '   ';
      const { requireAdminAuth } = require('../../src/lib/auth-admin');
      
      // Trimmed to empty, so no auth required
      expect(() => requireAdminAuth()).not.toThrow();
      expect(() => requireAdminAuth('Bearer anything')).not.toThrow();
    });
  });
});
