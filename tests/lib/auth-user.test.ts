jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn((url: URL) => `JWKS_FOR_${url.toString()}`),
  jwtVerify: jest.fn(),
}));

describe('auth-user', () => {
  let mockJwtVerify: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    const jose = require('jose');
    mockJwtVerify = jose.jwtVerify;
    mockJwtVerify.mockClear();
  });

  afterEach(() => {
    delete process.env.AUTH_MODE;
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_AUDIENCE;
    delete process.env.AUTH0_CLIENT_ID;
  });

  describe('maybeRequireUserAuth', () => {
    describe('when AUTH_MODE is admin', () => {
      it('should return null without checking token', async () => {
        process.env.AUTH_MODE = 'admin';
        process.env.AUTH0_DOMAIN = 'test.auth0.com';
        
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        const result = await maybeRequireUserAuth('Bearer valid-token');
        
        expect(result).toBeNull();
        expect(mockJwtVerify).not.toHaveBeenCalled();
      });
    });

    describe('when AUTH_MODE is user', () => {
      beforeEach(() => {
        process.env.AUTH_MODE = 'user';
        process.env.AUTH0_DOMAIN = 'test.auth0.com';
        process.env.AUTH0_AUDIENCE = 'https://api.example.com';
      });

      it('should verify valid token and return userId', async () => {
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'auth0|12345' },
          protectedHeader: { alg: 'RS256' },
        } as any);
        
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');

        const result = await maybeRequireUserAuth('Bearer valid-token');

        expect(result).toEqual({ userId: 'auth0|12345' });
        expect(mockJwtVerify).toHaveBeenCalledWith(
          'valid-token',
          expect.any(String), // JWKS
          expect.objectContaining({
            issuer: 'https://test.auth0.com/',
            audience: 'https://api.example.com',
          })
        );
      });

      it('should trim whitespace from token', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'auth0|12345' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await maybeRequireUserAuth('Bearer   token-with-spaces   ');

        expect(mockJwtVerify).toHaveBeenCalledWith(
          'token-with-spaces',
          expect.any(String),
          expect.any(Object)
        );
      });

      it('should trim whitespace from sub claim', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: '  auth0|12345  ' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        const result = await maybeRequireUserAuth('Bearer token');

        expect(result).toEqual({ userId: 'auth0|12345' });
      });

      it('should throw when AUTH0_DOMAIN not configured', async () => {
        delete process.env.AUTH0_DOMAIN;
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');

        await expect(maybeRequireUserAuth('Bearer token'))
          .rejects.toThrow('Auth0 not configured');
      });

      it('should throw when Authorization header missing', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');

        await expect(maybeRequireUserAuth(undefined))
          .rejects.toThrow('Missing Authorization header');
      });

      it('should throw when Authorization header empty', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');

        await expect(maybeRequireUserAuth(''))
          .rejects.toThrow('Missing Authorization header');
      });

      it('should throw when not Bearer scheme', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');

        await expect(maybeRequireUserAuth('Basic dXNlcjpwYXNz'))
          .rejects.toThrow('Authorization header must start with \'Bearer \'');
      });

      it('should throw when token is empty after Bearer', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');

        await expect(maybeRequireUserAuth('Bearer '))
          .rejects.toThrow('Authorization header contains empty token');
      });

      it('should throw when token is only whitespace', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');

        await expect(maybeRequireUserAuth('Bearer    '))
          .rejects.toThrow('Authorization header contains empty token');
      });

      it('should throw when sub claim missing', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: {},
          protectedHeader: { alg: 'RS256' },
        } as any);

        await expect(maybeRequireUserAuth('Bearer token'))
          .rejects.toThrow('Token missing \'sub\' claim');
      });

      it('should throw when sub claim is empty string', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: '' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await expect(maybeRequireUserAuth('Bearer token'))
          .rejects.toThrow('Token missing \'sub\' claim');
      });

      it('should throw when sub claim is only whitespace', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: '   ' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await expect(maybeRequireUserAuth('Bearer token'))
          .rejects.toThrow('Token missing \'sub\' claim');
      });

      it('should handle expired token error', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        const error: any = new Error('Token expired');
        error.code = 'ERR_JWT_EXPIRED';
        error.claim = '2024-01-01T00:00:00Z';
        mockJwtVerify.mockRejectedValueOnce(error);

        await expect(maybeRequireUserAuth('Bearer expired'))
          .rejects.toThrow('Token expired at 2024-01-01T00:00:00Z');
      });

      it('should handle claim validation error', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        const error: any = new Error('Validation failed');
        error.code = 'ERR_JWT_CLAIM_VALIDATION_FAILED';
        error.claim = 'aud';
        error.reason = 'invalid';
        mockJwtVerify.mockRejectedValueOnce(error);

        await expect(maybeRequireUserAuth('Bearer invalid'))
          .rejects.toThrow('JWT claim validation failed: aud (reason: invalid)');
      });

      it('should handle audience mismatch error', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        const error: any = new Error('audience mismatch');
        error.claim = 'wrong-audience';
        mockJwtVerify.mockRejectedValueOnce(error);

        await expect(maybeRequireUserAuth('Bearer wrong-aud'))
          .rejects.toThrow('Invalid audience - expected: https://api.example.com');
      });

      it('should handle issuer mismatch error', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        const error: any = new Error('issuer mismatch');
        error.claim = 'wrong-issuer';
        mockJwtVerify.mockRejectedValueOnce(error);

        await expect(maybeRequireUserAuth('Bearer wrong-iss'))
          .rejects.toThrow('Invalid issuer - expected: https://test.auth0.com/');
      });

      it('should handle generic JWT error', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockRejectedValueOnce(new Error('Invalid signature'));

        await expect(maybeRequireUserAuth('Bearer invalid'))
          .rejects.toThrow('Token validation failed: Invalid signature');
      });

      it('should handle multiple audiences (AUD + CLIENT)', async () => {
        process.env.AUTH0_CLIENT_ID = 'client123';
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'user1' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await maybeRequireUserAuth('Bearer token');

        expect(mockJwtVerify).toHaveBeenCalledWith(
          'token',
          expect.any(String),
          expect.objectContaining({
            audience: ['https://api.example.com', 'client123'],
          })
        );
      });

      it('should handle CLIENT_ID only (no AUD)', async () => {
        delete process.env.AUTH0_AUDIENCE;
        process.env.AUTH0_CLIENT_ID = 'client456';
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'user2' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await maybeRequireUserAuth('Bearer token');

        expect(mockJwtVerify).toHaveBeenCalledWith(
          'token',
          expect.any(String),
          expect.objectContaining({
            audience: 'client456',
          })
        );
      });

      it('should omit audience when neither AUD nor CLIENT set', async () => {
        delete process.env.AUTH0_AUDIENCE;
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'user3' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await maybeRequireUserAuth('Bearer token');

        const call = mockJwtVerify.mock.calls[0][2];
        expect(call).not.toHaveProperty('audience');
      });
    });

    describe('when AUTH_MODE is mixed', () => {
      beforeEach(() => {
        process.env.AUTH_MODE = 'mixed';
        process.env.AUTH0_DOMAIN = 'test.auth0.com';
      });

      it('should verify token like user mode', async () => {
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'mixed-user' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        const result = await maybeRequireUserAuth('Bearer token');

        expect(result).toEqual({ userId: 'mixed-user' });
        expect(mockJwtVerify).toHaveBeenCalled();
      });
    });

    describe('when AUTH_MODE is unrecognized', () => {
      it('should return null like admin mode', async () => {
        process.env.AUTH_MODE = 'unknown';
        process.env.AUTH0_DOMAIN = 'test.auth0.com';
        
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        const result = await maybeRequireUserAuth('Bearer token');
        
        expect(result).toBeNull();
        expect(mockJwtVerify).not.toHaveBeenCalled();
      });
    });

    describe('case insensitivity', () => {
      it('should handle AUTH_MODE in uppercase', async () => {
        process.env.AUTH_MODE = 'USER';
        process.env.AUTH0_DOMAIN = 'test.auth0.com';
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'user' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        const result = await maybeRequireUserAuth('Bearer token');

        expect(result).toEqual({ userId: 'user' });
      });

      it('should handle AUTH_MODE in mixed case', async () => {
        process.env.AUTH_MODE = 'MiXeD';
        process.env.AUTH0_DOMAIN = 'test.auth0.com';
        const { maybeRequireUserAuth } = require('../../src/lib/auth-user');
        
        mockJwtVerify.mockResolvedValueOnce({
          payload: { sub: 'user' },
          protectedHeader: { alg: 'RS256' },
        } as any);

        const result = await maybeRequireUserAuth('Bearer token');

        expect(result).toEqual({ userId: 'user' });
      });
    });
  });

  describe('requireUserAuth', () => {
    beforeEach(() => {
      process.env.AUTH_MODE = 'user';
      process.env.AUTH0_DOMAIN = 'test.auth0.com';
    });

    it('should return user when authentication succeeds', async () => {
      const { requireUserAuth } = require('../../src/lib/auth-user');
      
      mockJwtVerify.mockResolvedValueOnce({
        payload: { sub: 'required-user' },
        protectedHeader: { alg: 'RS256' },
      } as any);

      const result = await requireUserAuth('Bearer token');

      expect(result).toEqual({ userId: 'required-user' });
    });

    it('should throw when AUTH_MODE is admin', async () => {
      process.env.AUTH_MODE = 'admin';
      const { requireUserAuth } = require('../../src/lib/auth-user');

      await expect(requireUserAuth('Bearer token'))
        .rejects.toThrow('User authentication not enabled');
    });

    it('should throw when AUTH_MODE is unrecognized', async () => {
      process.env.AUTH_MODE = 'unknown';
      const { requireUserAuth } = require('../../src/lib/auth-user');

      await expect(requireUserAuth('Bearer token'))
        .rejects.toThrow('User authentication not enabled');
    });

    it('should propagate validation errors', async () => {
      const { requireUserAuth } = require('../../src/lib/auth-user');

      await expect(requireUserAuth('Invalid header'))
        .rejects.toThrow('Authorization header must start with');
    });

    it('should propagate JWT errors', async () => {
      const { requireUserAuth } = require('../../src/lib/auth-user');
      
      mockJwtVerify.mockRejectedValueOnce(new Error('Bad token'));

      await expect(requireUserAuth('Bearer bad'))
        .rejects.toThrow('Token validation failed: Bad token');
    });
  });
});
