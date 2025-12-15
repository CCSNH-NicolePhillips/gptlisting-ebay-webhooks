import type { HandlerEvent } from "@netlify/functions";

// Store original env vars
const originalEnv = { ...process.env };

// Mock dependencies
let mockCreateRemoteJWKSet: jest.Mock;
let mockJwtVerify: jest.Mock;
let mockTokensStore: jest.Mock;
let mockStoreGet: jest.Mock;
let mockStoreSetJSON: jest.Mock;
let mockStoreDelete: jest.Mock;

describe("_auth", () => {
  beforeEach(() => {
    jest.resetModules();
    
    // Reset mocks
    mockStoreGet = jest.fn();
    mockStoreSetJSON = jest.fn();
    mockStoreDelete = jest.fn();
    mockJwtVerify = jest.fn();
    mockCreateRemoteJWKSet = jest.fn(() => "mock-jwks");
    mockTokensStore = jest.fn(() => ({
      get: mockStoreGet,
      setJSON: mockStoreSetJSON,
      delete: mockStoreDelete,
    }));
    
    // Set up module mocks
    jest.mock("jose", () => ({
      createRemoteJWKSet: mockCreateRemoteJWKSet,
      jwtVerify: mockJwtVerify,
    }));
    
    jest.mock("../../src/lib/_blobs.js", () => ({
      tokensStore: mockTokensStore,
    }));
    
    // Set default environment
    process.env.AUTH0_DOMAIN = "test.auth0.com";
    process.env.AUTH0_CLIENT_ID = "test-client-id";
    process.env.AUTH0_AUDIENCE = "test-audience";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe("getBearerToken", () => {
    it("should extract bearer token from Authorization header", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { Authorization: "Bearer test-token-123" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBe("test-token-123");
    });

    it("should extract bearer token from lowercase authorization header", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { authorization: "Bearer test-token-456" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBe("test-token-456");
    });

    it("should handle case-insensitive Bearer prefix", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { Authorization: "bearer test-token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBe("test-token");
    });

    it("should trim whitespace from token", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { Authorization: "Bearer   test-token   " },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBe("test-token");
    });

    it("should return null when no authorization header exists", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: {},
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBeNull();
    });

    it("should return null when authorization header is empty", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { Authorization: "" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBeNull();
    });

    it("should return null when authorization header does not start with Bearer", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { Authorization: "Basic test-token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBeNull();
    });

    it("should handle undefined headers", async () => {
      const { getBearerToken } = await import("../../src/lib/_auth.js");
      
      const event = {} as Partial<HandlerEvent> as HandlerEvent;
      
      const token = getBearerToken(event);
      
      expect(token).toBeNull();
    });
  });

  describe("getJwtSubUnverified", () => {
    it("should extract sub from JWT payload without verification", async () => {
      const { getJwtSubUnverified } = await import("../../src/lib/_auth.js");
      
      // Create a valid JWT structure (header.payload.signature)
      const payload = { sub: "auth0|12345", iat: 123456 };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const sub = getJwtSubUnverified(event);
      
      expect(sub).toBe("auth0|12345");
    });

    it("should return null when no bearer token exists", async () => {
      const { getJwtSubUnverified } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: {},
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const sub = getJwtSubUnverified(event);
      
      expect(sub).toBeNull();
    });

    it("should return null when JWT has invalid structure", async () => {
      const { getJwtSubUnverified } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { Authorization: "Bearer invalid-token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const sub = getJwtSubUnverified(event);
      
      expect(sub).toBeNull();
    });

    it("should return null when JWT payload is not valid JSON", async () => {
      const { getJwtSubUnverified } = await import("../../src/lib/_auth.js");
      
      const token = "header.invalid-base64.signature";
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const sub = getJwtSubUnverified(event);
      
      expect(sub).toBeNull();
    });

    it("should return null when sub is not a string", async () => {
      const { getJwtSubUnverified } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: 12345, iat: 123456 };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const sub = getJwtSubUnverified(event);
      
      expect(sub).toBeNull();
    });

    it("should return null when sub is missing", async () => {
      const { getJwtSubUnverified } = await import("../../src/lib/_auth.js");
      
      const payload = { iat: 123456 };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const sub = getJwtSubUnverified(event);
      
      expect(sub).toBeNull();
    });

    it("should handle base64 URL-safe encoding with - and _", async () => {
      const { getJwtSubUnverified } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user", iat: 123456 };
      // Use standard base64, the code will convert - to + and _ to /
      const payloadJson = JSON.stringify(payload);
      const payloadBase64 = Buffer.from(payloadJson).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const sub = getJwtSubUnverified(event);
      
      expect(sub).toBe("auth0|user");
    });
  });

  describe("requireAuthVerified", () => {
    it("should verify token and return sub and claims", async () => {
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user123", email: "test@example.com" };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      mockJwtVerify.mockResolvedValueOnce({ payload });
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuthVerified(event);
      
      expect(result).toEqual({
        sub: "auth0|user123",
        claims: payload,
      });
      
      expect(mockJwtVerify).toHaveBeenCalledWith(
        token,
        "mock-jwks",
        {
          issuer: "https://test.auth0.com/",
          audience: ["test-client-id", "test-audience"],
        }
      );
    });

    it("should use only client ID when AUTH0_AUDIENCE is not set", async () => {
      delete process.env.AUTH0_AUDIENCE;
      
      jest.resetModules();
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user123" };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      mockJwtVerify.mockResolvedValueOnce({ payload });
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      await requireAuthVerified(event);
      
      expect(mockJwtVerify).toHaveBeenCalledWith(
        token,
        "mock-jwks",
        {
          issuer: "https://test.auth0.com/",
          audience: ["test-client-id"],
        }
      );
    });

    it("should return null when Auth0 configuration is missing", async () => {
      delete process.env.AUTH0_DOMAIN;
      
      jest.resetModules();
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuthVerified(event);
      
      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[Auth] Missing Auth0 configuration:",
        expect.any(Object)
      );
      
      consoleErrorSpy.mockRestore();
    });

    it("should return null when no bearer token is present", async () => {
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();
      
      const event = {
        headers: {},
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuthVerified(event);
      
      expect(result).toBeNull();
      expect(consoleLogSpy).toHaveBeenCalledWith("[Auth] No bearer token found in request");
      
      consoleLogSpy.mockRestore();
    });

    it("should return null when token verification fails", async () => {
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      
      mockJwtVerify.mockRejectedValueOnce(new Error("Invalid signature"));
      
      const event = {
        headers: { Authorization: "Bearer invalid-token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuthVerified(event);
      
      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[Auth] Token verification failed:",
        expect.objectContaining({
          error: "Invalid signature",
        })
      );
      
      consoleErrorSpy.mockRestore();
    });

    it("should return null when sub claim is missing from verified token", async () => {
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      
      mockJwtVerify.mockResolvedValueOnce({ payload: { email: "test@example.com" } });
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuthVerified(event);
      
      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith("[Auth] Token verified but no sub claim found");
      
      consoleErrorSpy.mockRestore();
    });

    it("should return null when sub claim is not a string", async () => {
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      
      mockJwtVerify.mockResolvedValueOnce({ payload: { sub: 12345 } });
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuthVerified(event);
      
      expect(result).toBeNull();
      
      consoleErrorSpy.mockRestore();
    });

    it("should handle non-Error exceptions", async () => {
      const { requireAuthVerified } = await import("../../src/lib/_auth.js");
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      
      mockJwtVerify.mockRejectedValueOnce("string error");
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuthVerified(event);
      
      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[Auth] Token verification failed:",
        expect.objectContaining({
          error: "string error",
        })
      );
      
      consoleErrorSpy.mockRestore();
    });
  });

  describe("requireAuth", () => {
    it("should return user info with email and name", async () => {
      const { requireAuth } = await import("../../src/lib/_auth.js");
      
      const payload = {
        sub: "auth0|user123",
        email: "test@example.com",
        name: "Test User",
      };
      
      mockJwtVerify.mockResolvedValueOnce({ payload });
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuth(event);
      
      expect(result).toEqual({
        sub: "auth0|user123",
        email: "test@example.com",
        name: "Test User",
      });
    });

    it("should return user info without email and name when not present", async () => {
      const { requireAuth } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user123" };
      
      mockJwtVerify.mockResolvedValueOnce({ payload });
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuth(event);
      
      expect(result).toEqual({
        sub: "auth0|user123",
        email: undefined,
        name: undefined,
      });
    });

    it("should return null when token verification fails", async () => {
      const { requireAuth } = await import("../../src/lib/_auth.js");
      
      jest.spyOn(console, "error").mockImplementation();
      
      mockJwtVerify.mockRejectedValueOnce(new Error("Invalid token"));
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuth(event);
      
      expect(result).toBeNull();
    });

    it("should handle non-string email claim", async () => {
      const { requireAuth } = await import("../../src/lib/_auth.js");
      
      const payload = {
        sub: "auth0|user123",
        email: 12345,
        name: "Test User",
      };
      
      mockJwtVerify.mockResolvedValueOnce({ payload });
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuth(event);
      
      expect(result).toEqual({
        sub: "auth0|user123",
        email: undefined,
        name: "Test User",
      });
    });

    it("should handle non-string name claim", async () => {
      const { requireAuth } = await import("../../src/lib/_auth.js");
      
      const payload = {
        sub: "auth0|user123",
        email: "test@example.com",
        name: 12345,
      };
      
      mockJwtVerify.mockResolvedValueOnce({ payload });
      
      const event = {
        headers: { Authorization: "Bearer token" },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const result = await requireAuth(event);
      
      expect(result).toEqual({
        sub: "auth0|user123",
        email: "test@example.com",
        name: undefined,
      });
    });
  });

  describe("json", () => {
    it("should return JSON response with default status 200", async () => {
      const { json } = await import("../../src/lib/_auth.js");
      
      const result = json({ message: "success" });
      
      expect(result).toEqual({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "success" }),
      });
    });

    it("should return JSON response with custom status code", async () => {
      const { json } = await import("../../src/lib/_auth.js");
      
      const result = json({ error: "Not found" }, 404);
      
      expect(result).toEqual({
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Not found" }),
      });
    });

    it("should handle null body", async () => {
      const { json } = await import("../../src/lib/_auth.js");
      
      const result = json(null);
      
      expect(result).toEqual({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
    });

    it("should handle array body", async () => {
      const { json } = await import("../../src/lib/_auth.js");
      
      const result = json([1, 2, 3]);
      
      expect(result).toEqual({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: "[1,2,3]",
      });
    });
  });

  describe("userScopedKey", () => {
    it("should create scoped key for user", async () => {
      const { userScopedKey } = await import("../../src/lib/_auth.js");
      
      const key = userScopedKey("auth0|user123", "settings.json");
      
      expect(key).toBe("users/auth0%7Cuser123/settings.json");
    });

    it("should encode special characters in sub", async () => {
      const { userScopedKey } = await import("../../src/lib/_auth.js");
      
      const key = userScopedKey("user@email.com", "data.json");
      
      expect(key).toBe("users/user%40email.com/data.json");
    });

    it("should return unscoped key when sub is null", async () => {
      const { userScopedKey } = await import("../../src/lib/_auth.js");
      
      const key = userScopedKey(null, "global.json");
      
      expect(key).toBe("global.json");
    });

    it("should return unscoped key when sub is empty string", async () => {
      const { userScopedKey } = await import("../../src/lib/_auth.js");
      
      const key = userScopedKey("", "global.json");
      
      expect(key).toBe("global.json");
    });
  });

  describe("createOAuthStateForUser", () => {
    it("should create OAuth state with nonce and store it", async () => {
      const { createOAuthStateForUser } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user123" };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const nonce = await createOAuthStateForUser(event, "ebay");
      
      expect(nonce).toBeTruthy();
      expect(typeof nonce).toBe("string");
      expect(mockStoreSetJSON).toHaveBeenCalledWith(
        `oauth-state/${nonce}.json`,
        expect.objectContaining({
          sub: "auth0|user123",
          provider: "ebay",
          createdAt: expect.any(Number),
        })
      );
    });

    it("should include extras in OAuth state", async () => {
      const { createOAuthStateForUser } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user123" };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const nonce = await createOAuthStateForUser(event, "dropbox", {
        returnTo: "/dashboard",
      });
      
      expect(mockStoreSetJSON).toHaveBeenCalledWith(
        `oauth-state/${nonce}.json`,
        expect.objectContaining({
          sub: "auth0|user123",
          provider: "dropbox",
          returnTo: "/dashboard",
        })
      );
    });

    it("should return null when no bearer token exists", async () => {
      const { createOAuthStateForUser } = await import("../../src/lib/_auth.js");
      
      const event = {
        headers: {},
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const nonce = await createOAuthStateForUser(event, "ebay");
      
      expect(nonce).toBeNull();
      expect(mockStoreSetJSON).not.toHaveBeenCalled();
    });

    it("should use crypto.randomUUID when available", async () => {
      const mockRandomUUID = jest.fn(() => "uuid-123-456");
      (globalThis as any).crypto = { randomUUID: mockRandomUUID };
      
      jest.resetModules();
      const { createOAuthStateForUser } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user123" };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const nonce = await createOAuthStateForUser(event, "ebay");
      
      expect(nonce).toBe("uuid-123-456");
      expect(mockRandomUUID).toHaveBeenCalled();
      
      delete (globalThis as any).crypto;
    });

    it("should fallback to Math.random when crypto.randomUUID unavailable", async () => {
      delete (globalThis as any).crypto;
      
      jest.resetModules();
      const { createOAuthStateForUser } = await import("../../src/lib/_auth.js");
      
      const payload = { sub: "auth0|user123" };
      const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const token = `header.${payloadBase64}.signature`;
      
      const event = {
        headers: { Authorization: `Bearer ${token}` },
      } as Partial<HandlerEvent> as HandlerEvent;
      
      const nonce = await createOAuthStateForUser(event, "ebay");
      
      expect(nonce).toBeTruthy();
      expect(typeof nonce).toBe("string");
    });
  });

  describe("consumeOAuthState", () => {
    it("should retrieve and delete OAuth state", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      const stateData = {
        sub: "auth0|user123",
        provider: "ebay",
        createdAt: Date.now(),
      };
      
      mockStoreGet.mockResolvedValueOnce(stateData);
      
      const result = await consumeOAuthState("test-nonce");
      
      expect(result).toEqual({
        sub: "auth0|user123",
        provider: "ebay",
        createdAt: expect.any(Number),
      });
      
      expect(mockStoreGet).toHaveBeenCalledWith("oauth-state/test-nonce.json", { type: "json" });
      expect(mockStoreDelete).toHaveBeenCalledWith("oauth-state/test-nonce.json");
    });

    it("should return null when state is null", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      const result = await consumeOAuthState(null);
      
      expect(result).toBeNull();
      expect(mockStoreGet).not.toHaveBeenCalled();
    });

    it("should return null when state is empty string", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      const result = await consumeOAuthState("");
      
      expect(result).toBeNull();
    });

    it("should return null when state data is not found", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      mockStoreGet.mockResolvedValueOnce(null);
      
      const result = await consumeOAuthState("invalid-nonce");
      
      expect(result).toBeNull();
    });

    it("should return null when state data has no sub", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      mockStoreGet.mockResolvedValueOnce({ provider: "ebay" });
      
      const result = await consumeOAuthState("test-nonce");
      
      expect(result).toBeNull();
    });

    it("should convert non-string sub to string", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      mockStoreGet.mockResolvedValueOnce({ sub: 12345, provider: "ebay" });
      
      const result = await consumeOAuthState("test-nonce");
      
      expect(result?.sub).toBe("12345");
    });

    it("should handle store errors gracefully", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      mockStoreGet.mockRejectedValueOnce(new Error("Store error"));
      
      const result = await consumeOAuthState("test-nonce");
      
      expect(result).toBeNull();
    });

    it("should handle delete errors gracefully", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      const stateData = {
        sub: "auth0|user123",
        provider: "ebay",
      };
      
      mockStoreGet.mockResolvedValueOnce(stateData);
      mockStoreDelete.mockRejectedValueOnce(new Error("Delete error"));
      
      const result = await consumeOAuthState("test-nonce");
      
      // Should still return the state data even if delete fails
      expect(result).toEqual({
        sub: "auth0|user123",
        provider: "ebay",
      });
    });

    it("should handle missing delete method", async () => {
      const { consumeOAuthState } = await import("../../src/lib/_auth.js");
      
      const stateData = {
        sub: "auth0|user123",
        provider: "ebay",
      };
      
      mockStoreGet.mockResolvedValueOnce(stateData);
      mockTokensStore.mockReturnValueOnce({
        get: mockStoreGet,
        setJSON: mockStoreSetJSON,
        // No delete method
      });
      
      const result = await consumeOAuthState("test-nonce");
      
      // Should still return the state data
      expect(result).toEqual({
        sub: "auth0|user123",
        provider: "ebay",
      });
    });
  });
});

