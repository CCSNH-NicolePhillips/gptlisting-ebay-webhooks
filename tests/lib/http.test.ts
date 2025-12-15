/**
 * Tests for http.ts
 * Target: 100% code coverage for HTTP utilities
 */

import {
  parseAllowedOrigins,
  isOriginAllowed,
  getOrigin,
  corsHeaders,
  json,
  jsonResponse,
  extractBearerToken,
  isAuthorized,
  isUserMode,
} from '../../src/lib/http';

describe('http', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseAllowedOrigins', () => {
    it('should return empty array when ALLOWED_ORIGINS not set', () => {
      delete process.env.ALLOWED_ORIGINS;
      jest.resetModules();
      const { parseAllowedOrigins } = require('../../src/lib/http');
      
      expect(parseAllowedOrigins()).toEqual([]);
    });

    it('should parse single origin', () => {
      process.env.ALLOWED_ORIGINS = 'https://example.com';
      jest.resetModules();
      const { parseAllowedOrigins } = require('../../src/lib/http');
      
      expect(parseAllowedOrigins()).toEqual(['https://example.com']);
    });

    it('should parse multiple origins separated by comma', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com,https://api.com,https://www.site.com';
      jest.resetModules();
      const { parseAllowedOrigins } = require('../../src/lib/http');
      
      expect(parseAllowedOrigins()).toEqual([
        'https://app.com',
        'https://api.com',
        'https://www.site.com',
      ]);
    });

    it('should trim whitespace from origins', () => {
      process.env.ALLOWED_ORIGINS = ' https://app.com , https://api.com , https://site.com ';
      jest.resetModules();
      const { parseAllowedOrigins } = require('../../src/lib/http');
      
      expect(parseAllowedOrigins()).toEqual([
        'https://app.com',
        'https://api.com',
        'https://site.com',
      ]);
    });

    it('should filter out empty strings', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com,,https://api.com,,,';
      jest.resetModules();
      const { parseAllowedOrigins } = require('../../src/lib/http');
      
      expect(parseAllowedOrigins()).toEqual(['https://app.com', 'https://api.com']);
    });
  });

  describe('isOriginAllowed', () => {
    it('should allow all origins when ALLOWED_ORIGINS is empty', () => {
      delete process.env.ALLOWED_ORIGINS;
      jest.resetModules();
      const { isOriginAllowed } = require('../../src/lib/http');
      
      expect(isOriginAllowed('https://any-site.com')).toBe(true);
      expect(isOriginAllowed('http://localhost:3000')).toBe(true);
    });

    it('should return false when no origin header provided and list not empty', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com';
      jest.resetModules();
      const { isOriginAllowed } = require('../../src/lib/http');
      
      expect(isOriginAllowed(undefined)).toBe(false);
      expect(isOriginAllowed('')).toBe(false);
    });

    it('should allow origin in whitelist', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com,https://api.com';
      jest.resetModules();
      const { isOriginAllowed } = require('../../src/lib/http');
      
      expect(isOriginAllowed('https://app.com')).toBe(true);
      expect(isOriginAllowed('https://api.com')).toBe(true);
    });

    it('should reject origin not in whitelist', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com';
      jest.resetModules();
      const { isOriginAllowed } = require('../../src/lib/http');
      
      expect(isOriginAllowed('https://evil.com')).toBe(false);
    });

    it('should normalize origin before checking', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com';
      jest.resetModules();
      const { isOriginAllowed } = require('../../src/lib/http');
      
      // Should extract origin from full URL
      expect(isOriginAllowed('https://app.com/path?query=1')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com';
      jest.resetModules();
      const { isOriginAllowed } = require('../../src/lib/http');
      
      expect(isOriginAllowed('not-a-url')).toBe(false);
      expect(isOriginAllowed('://')).toBe(false);
    });

    it('should normalize hostname to lowercase', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com';
      jest.resetModules();
      const { isOriginAllowed } = require('../../src/lib/http');
      
      // URL constructor normalizes hostname to lowercase
      expect(isOriginAllowed('https://APP.com')).toBe(true);
    });
  });

  describe('getOrigin', () => {
    it('should extract origin from "origin" header (lowercase)', () => {
      const headers = { origin: 'https://app.com' };
      
      expect(getOrigin(headers)).toBe('https://app.com');
    });

    it('should extract origin from "Origin" header (capitalized)', () => {
      const headers = { Origin: 'https://app.com' };
      
      expect(getOrigin(headers)).toBe('https://app.com');
    });

    it('should extract origin from "access-control-request-origin" header', () => {
      const headers = { 'access-control-request-origin': 'https://app.com' };
      
      expect(getOrigin(headers)).toBe('https://app.com');
    });

    it('should extract origin from "Access-Control-Request-Origin" header', () => {
      const headers = { 'Access-Control-Request-Origin': 'https://app.com' };
      
      expect(getOrigin(headers)).toBe('https://app.com');
    });

    it('should prioritize "origin" over "referer"', () => {
      const headers = {
        origin: 'https://app.com',
        referer: 'https://other.com/page',
      };
      
      expect(getOrigin(headers)).toBe('https://app.com');
    });

    it('should fall back to "referer" when no origin header', () => {
      const headers = { referer: 'https://app.com/page?query=1' };
      
      expect(getOrigin(headers)).toBe('https://app.com');
    });

    it('should fall back to "Referer" (capitalized) when no origin', () => {
      const headers = { Referer: 'https://app.com/page' };
      
      expect(getOrigin(headers)).toBe('https://app.com');
    });

    it('should return undefined when no origin or referer', () => {
      const headers = {};
      
      expect(getOrigin(headers)).toBeUndefined();
    });

    it('should return undefined for invalid referer URL', () => {
      const headers = { referer: 'not-a-valid-url' };
      
      expect(getOrigin(headers)).toBeUndefined();
    });

    it('should return undefined for empty origin header with no referer', () => {
      const headers = { origin: '' };
      
      // Empty string is falsy in || chain, falls through to undefined
      expect(getOrigin(headers)).toBeUndefined();
    });
  });

  describe('corsHeaders', () => {
    it('should return CORS headers with wildcard when no allowed origins', () => {
      delete process.env.ALLOWED_ORIGINS;
      jest.resetModules();
      const { corsHeaders } = require('../../src/lib/http');
      
      const headers = corsHeaders();
      
      expect(headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('should use provided origin if allowed', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com';
      jest.resetModules();
      const { corsHeaders } = require('../../src/lib/http');
      
      const headers = corsHeaders('https://app.com');
      
      expect(headers['Access-Control-Allow-Origin']).toBe('https://app.com');
    });

    it('should use first allowed origin if provided origin not allowed', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com,https://api.com';
      jest.resetModules();
      const { corsHeaders } = require('../../src/lib/http');
      
      const headers = corsHeaders('https://evil.com');
      
      expect(headers['Access-Control-Allow-Origin']).toBe('https://app.com');
    });

    it('should include default methods', () => {
      const headers = corsHeaders();
      
      expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    });

    it('should allow custom methods', () => {
      const headers = corsHeaders(undefined, 'GET, PUT, DELETE');
      
      expect(headers['Access-Control-Allow-Methods']).toBe('GET, PUT, DELETE');
    });

    it('should include Content-Type header', () => {
      const headers = corsHeaders();
      
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should include Allow-Headers', () => {
      const headers = corsHeaders();
      
      expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    });

    it('should include Vary Origin header', () => {
      const headers = corsHeaders();
      
      expect(headers['Vary']).toBe('Origin');
    });
  });

  describe('json', () => {
    it('should return response with status code', () => {
      const response = json(200, { ok: true });
      
      expect(response.statusCode).toBe(200);
    });

    it('should stringify body as JSON', () => {
      const response = json(200, { ok: true, data: 'test' });
      
      expect(response.body).toBe('{"ok":true,"data":"test"}');
    });

    it('should include CORS headers', () => {
      const response = json(200, { ok: true });
      
      expect(response.headers).toHaveProperty('Access-Control-Allow-Origin');
      expect(response.headers).toHaveProperty('Content-Type', 'application/json');
    });

    it('should pass origin to corsHeaders', () => {
      process.env.ALLOWED_ORIGINS = 'https://app.com';
      jest.resetModules();
      const { json } = require('../../src/lib/http');
      
      const response = json(200, { ok: true }, 'https://app.com');
      
      expect(response.headers['Access-Control-Allow-Origin']).toBe('https://app.com');
    });

    it('should pass methods to corsHeaders', () => {
      const response = json(200, { ok: true }, undefined, 'GET, DELETE');
      
      expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, DELETE');
    });

    it('should merge extra headers', () => {
      const response = json(200, { ok: true }, undefined, 'GET, POST', {
        'X-Custom-Header': 'value',
        'X-Another': 'test',
      });
      
      expect(response.headers['X-Custom-Header']).toBe('value');
      expect(response.headers['X-Another']).toBe('test');
    });

    it('should allow extra headers to override CORS headers', () => {
      const response = json(200, { ok: true }, undefined, 'GET, POST', {
        'Content-Type': 'text/plain',
      });
      
      expect(response.headers['Content-Type']).toBe('text/plain');
    });

    it('should handle different status codes', () => {
      expect(json(200, {}).statusCode).toBe(200);
      expect(json(201, {}).statusCode).toBe(201);
      expect(json(400, {}).statusCode).toBe(400);
      expect(json(404, {}).statusCode).toBe(404);
      expect(json(500, {}).statusCode).toBe(500);
    });

    it('should handle complex nested objects', () => {
      const data = {
        user: { id: 1, name: 'Test' },
        items: [{ a: 1 }, { b: 2 }],
      };
      const response = json(200, data);
      
      expect(JSON.parse(response.body)).toEqual(data);
    });
  });

  describe('jsonResponse', () => {
    it('should be an alias for json function', () => {
      const response1 = json(200, { ok: true }, 'https://app.com', 'GET, POST', { 'X-Test': 'value' });
      const response2 = jsonResponse(200, { ok: true }, 'https://app.com', 'GET, POST', { 'X-Test': 'value' });
      
      expect(response2).toEqual(response1);
    });
  });

  describe('extractBearerToken', () => {
    it('should extract token from "authorization" header (lowercase)', () => {
      const headers = { authorization: 'Bearer abc123' };
      
      expect(extractBearerToken(headers)).toBe('abc123');
    });

    it('should extract token from "Authorization" header (capitalized)', () => {
      const headers = { Authorization: 'Bearer xyz789' };
      
      expect(extractBearerToken(headers)).toBe('xyz789');
    });

    it('should trim whitespace from token', () => {
      const headers = { authorization: 'Bearer   token123   ' };
      
      expect(extractBearerToken(headers)).toBe('token123');
    });

    it('should return empty string when no authorization header', () => {
      const headers = {};
      
      expect(extractBearerToken(headers)).toBe('');
    });

    it('should return empty string when not Bearer scheme', () => {
      const headers = { authorization: 'Basic abc123' };
      
      expect(extractBearerToken(headers)).toBe('');
    });

    it('should return empty string for malformed header', () => {
      const headers = { authorization: 'Bearer' };
      
      expect(extractBearerToken(headers)).toBe('');
    });

    it('should handle tokens with special characters', () => {
      const headers = { authorization: 'Bearer abc-123.xyz_456' };
      
      expect(extractBearerToken(headers)).toBe('abc-123.xyz_456');
    });

    it('should prioritize lowercase authorization header', () => {
      const headers = {
        authorization: 'Bearer lowercase-token',
        Authorization: 'Bearer uppercase-token',
      };
      
      expect(extractBearerToken(headers)).toBe('lowercase-token');
    });
  });

  describe('isAuthorized', () => {
    it('should return true when ADMIN_API_TOKEN not set', () => {
      delete process.env.ADMIN_API_TOKEN;
      jest.resetModules();
      const { isAuthorized } = require('../../src/lib/http');
      
      const headers = {};
      expect(isAuthorized(headers)).toBe(true);
    });

    it('should return true when token matches ADMIN_API_TOKEN', () => {
      process.env.ADMIN_API_TOKEN = 'secret123';
      jest.resetModules();
      const { isAuthorized } = require('../../src/lib/http');
      
      const headers = { authorization: 'Bearer secret123' };
      expect(isAuthorized(headers)).toBe(true);
    });

    it('should return false when token does not match', () => {
      process.env.ADMIN_API_TOKEN = 'secret123';
      jest.resetModules();
      const { isAuthorized } = require('../../src/lib/http');
      
      const headers = { authorization: 'Bearer wrong-token' };
      expect(isAuthorized(headers)).toBe(false);
    });

    it('should return false when no token provided', () => {
      process.env.ADMIN_API_TOKEN = 'secret123';
      jest.resetModules();
      const { isAuthorized } = require('../../src/lib/http');
      
      const headers = {};
      expect(isAuthorized(headers)).toBe(false);
    });

    it('should return false for empty token', () => {
      process.env.ADMIN_API_TOKEN = 'secret123';
      jest.resetModules();
      const { isAuthorized } = require('../../src/lib/http');
      
      const headers = { authorization: 'Bearer ' };
      expect(isAuthorized(headers)).toBe(false);
    });
  });

  describe('isUserMode', () => {
    it('should return false when AUTH_MODE is "admin"', () => {
      process.env.AUTH_MODE = 'admin';
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(false);
    });

    it('should return false when AUTH_MODE is "ADMIN" (uppercase)', () => {
      process.env.AUTH_MODE = 'ADMIN';
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(false);
    });

    it('should return true when AUTH_MODE is "user"', () => {
      process.env.AUTH_MODE = 'user';
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(true);
    });

    it('should return true when AUTH_MODE is "USER" (uppercase)', () => {
      process.env.AUTH_MODE = 'USER';
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(true);
    });

    it('should return true when AUTH_MODE is "mixed"', () => {
      process.env.AUTH_MODE = 'mixed';
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(true);
    });

    it('should return true when AUTH_MODE is "MIXED" (uppercase)', () => {
      process.env.AUTH_MODE = 'MIXED';
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(true);
    });

    it('should default to false (admin) when AUTH_MODE not set', () => {
      delete process.env.AUTH_MODE;
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(false);
    });

    it('should return false for unknown AUTH_MODE values', () => {
      process.env.AUTH_MODE = 'unknown';
      jest.resetModules();
      const { isUserMode } = require('../../src/lib/http');
      
      expect(isUserMode()).toBe(false);
    });
  });
});
