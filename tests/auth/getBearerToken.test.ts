import type { HandlerEvent } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified } from '../../src/lib/_auth.js';

describe('getBearerToken', () => {
  it('should extract bearer token from Authorization header', () => {
    const event = {
      headers: {
        Authorization: 'Bearer test-token-12345',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBe('test-token-12345');
  });

  it('should handle lowercase authorization header', () => {
    const event = {
      headers: {
        authorization: 'Bearer lowercase-token',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBe('lowercase-token');
  });

  it('should handle case-insensitive Bearer keyword', () => {
    const event = {
      headers: {
        Authorization: 'BEARER uppercase-bearer',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBe('uppercase-bearer');
  });

  it('should trim whitespace from token', () => {
    const event = {
      headers: {
        Authorization: 'Bearer   token-with-spaces   ',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBe('token-with-spaces');
  });

  it('should return null for missing Authorization header', () => {
    const event = {
      headers: {},
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBeNull();
  });

  it('should return null for empty Authorization header', () => {
    const event = {
      headers: {
        Authorization: '',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBeNull();
  });

  it('should return null for non-Bearer authorization', () => {
    const event = {
      headers: {
        Authorization: 'Basic dXNlcjpwYXNz',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBeNull();
  });

  it('should return null for malformed Bearer header', () => {
    const event = {
      headers: {
        Authorization: 'Bearer',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBeNull();
  });

  it('should handle Bearer with extra spaces', () => {
    const event = {
      headers: {
        Authorization: 'Bearer      multi-space-token',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getBearerToken(event)).toBe('multi-space-token');
  });
});

describe('getJwtSubUnverified', () => {
  // Helper to create a simple JWT (unverified, just for testing structure)
  function makeSimpleJwt(payload: any): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = Buffer.from('fake-signature').toString('base64url');
    return `${header}.${body}.${signature}`;
  }

  it('should extract sub from valid JWT', () => {
    const token = makeSimpleJwt({ sub: 'auth0|12345', iat: 1234567890 });
    const event = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBe('auth0|12345');
  });

  it('should return null if sub is missing', () => {
    const token = makeSimpleJwt({ iat: 1234567890, email: 'test@example.com' });
    const event = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBeNull();
  });

  it('should return null if sub is not a string', () => {
    const token = makeSimpleJwt({ sub: 12345, iat: 1234567890 });
    const event = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBeNull();
  });

  it('should return null for missing Authorization header', () => {
    const event = {
      headers: {},
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBeNull();
  });

  it('should return null for malformed JWT (not enough parts)', () => {
    const event = {
      headers: {
        Authorization: 'Bearer invalid.token',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBeNull();
  });

  it('should return null for invalid base64 in payload', () => {
    const event = {
      headers: {
        Authorization: 'Bearer header.!!!invalid!!!.signature',
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBeNull();
  });

  it('should return null for non-JSON payload', () => {
    const invalidPayload = Buffer.from('not json').toString('base64url');
    const event = {
      headers: {
        Authorization: `Bearer header.${invalidPayload}.signature`,
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBeNull();
  });

  it('should handle google-oauth2 sub format', () => {
    const token = makeSimpleJwt({ sub: 'google-oauth2|123456789012345678901' });
    const event = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    } as Partial<HandlerEvent> as HandlerEvent;

    expect(getJwtSubUnverified(event)).toBe('google-oauth2|123456789012345678901');
  });
});
