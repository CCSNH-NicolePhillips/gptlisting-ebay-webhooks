// Store original env vars
const originalEnv = { ...process.env };

// Mock dependencies
let mockAccessTokenFromRefresh: jest.Mock;
let mockTokenHosts: jest.Mock;
let mockTokensStore: jest.Mock;
let mockUserScopedKey: jest.Mock;

// Mock store instance
let mockStoreGet: jest.Mock;

describe("ebay-auth", () => {
  beforeEach(() => {
    jest.resetModules();
    
    // Reset mocks
    mockStoreGet = jest.fn();
    mockAccessTokenFromRefresh = jest.fn();
    mockTokenHosts = jest.fn();
    mockTokensStore = jest.fn(() => ({ get: mockStoreGet }));
    mockUserScopedKey = jest.fn((userId, file) => `user:${userId}:${file}`);
    
    // Set up module mocks
    jest.mock("../../src/lib/_common.js", () => ({
      accessTokenFromRefresh: mockAccessTokenFromRefresh,
      tokenHosts: mockTokenHosts,
    }));
    
    jest.mock("../../src/lib/redis-store.js", () => ({
      tokensStore: mockTokensStore,
    }));
    
    jest.mock("../../src/lib/_auth.js", () => ({
      userScopedKey: mockUserScopedKey,
    }));
    
    // Set default environment
    process.env.EBAY_REFRESH_TOKEN = "env-refresh-token";
    process.env.EBAY_ENV = "production";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe("getEbayAccessToken", () => {
    it("should use per-user token when userId provided", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "user-refresh-token",
      });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "user-access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessToken("user123");
      
      expect(mockUserScopedKey).toHaveBeenCalledWith("user123", "ebay.json");
      expect(mockStoreGet).toHaveBeenCalledWith("user:user123:ebay.json", { type: "json" });
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith(
        "user-refresh-token",
        expect.arrayContaining([
          'https://api.ebay.com/oauth/api_scope',
          'https://api.ebay.com/oauth/api_scope/sell.marketing',
        ])
      );
      expect(result).toEqual({
        token: "user-access-token",
        apiHost: "https://api.ebay.com",
      });
    });

    it("should fall back to global blob when user token not found", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      // Clear env var so it falls back to global blob
      delete process.env.EBAY_REFRESH_TOKEN;
      
      // First call returns null (no user token)
      mockStoreGet
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          refresh_token: "global-blob-token",
        });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "global-access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessToken("user123");
      
      expect(mockStoreGet).toHaveBeenCalledWith("user:user123:ebay.json", { type: "json" });
      expect(mockStoreGet).toHaveBeenCalledWith("ebay.json", { type: "json" });
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("global-blob-token", expect.any(Array));
      expect(result.token).toBe("global-access-token");
    });

    it("should fall back to env var when no blob tokens exist", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValue(null);
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "env-access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessToken("user123");
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", expect.any(Array));
      expect(result.token).toBe("env-access-token");
    });

    it("should use env var directly when no userId provided", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "env-access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessToken();
      
      expect(mockStoreGet).not.toHaveBeenCalled();
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", expect.any(Array));
      expect(result.token).toBe("env-access-token");
    });

    it("should throw error when no refresh token available", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      delete process.env.EBAY_REFRESH_TOKEN;
      mockStoreGet.mockResolvedValue(null);
      
      await expect(getEbayAccessToken()).rejects.toThrow(
        "EBAY_REFRESH_TOKEN env var is required or connect eBay for this user"
      );
    });

    it("should trim whitespace from refresh tokens", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "  user-token-with-spaces  ",
      });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      await getEbayAccessToken("user123");
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("user-token-with-spaces", expect.any(Array));
    });

    it("should handle user store errors gracefully", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockRejectedValueOnce(new Error("Store error"));
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "fallback-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessToken("user123");
      
      // Should fall back to env var
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", expect.any(Array));
      expect(result.token).toBe("fallback-token");
    });

    it("should handle global store errors gracefully", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockRejectedValue(new Error("Store error"));
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "env-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessToken("user123");
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", expect.any(Array));
      expect(result.token).toBe("env-token");
    });

    it("should throw error when access_token is missing", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({});
      
      await expect(getEbayAccessToken()).rejects.toThrow("Failed to obtain eBay access token");
    });

    it("should request all required scopes", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      await getEbayAccessToken();
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.account',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.marketing',
      ]);
    });

    it("should use correct API host from tokenHosts", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.sandbox.ebay.com",
      });
      
      const result = await getEbayAccessToken();
      
      expect(mockTokenHosts).toHaveBeenCalledWith("production");
      expect(result.apiHost).toBe("https://api.sandbox.ebay.com");
    });

    it("should handle non-string refresh_token in blob", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: 12345,
      });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      await getEbayAccessToken("user123");
      
      // Should fall back to env var when blob token is not string
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", expect.any(Array));
    });

    it("should handle empty string refresh_token in blob", async () => {
      const { getEbayAccessToken } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "   ",
      });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      await getEbayAccessToken("user123");
      
      // Should fall back to env var when blob token is empty after trim
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", expect.any(Array));
    });
  });

  describe("getEbayAccessTokenStrict", () => {
    it("should require per-user token when userId provided", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "user-refresh-token",
      });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "user-access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessTokenStrict("user123");
      
      expect(result).toEqual({
        token: "user-access-token",
        apiHost: "https://api.ebay.com",
      });
    });

    it("should throw error when user token not found", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce(null);
      
      await expect(getEbayAccessTokenStrict("user123")).rejects.toThrow(
        "No eBay token for this user. Connect eBay in Setup."
      );
    });

    it("should throw error when user token is empty string", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "   ",
      });
      
      await expect(getEbayAccessTokenStrict("user123")).rejects.toThrow(
        "No eBay token for this user. Connect eBay in Setup."
      );
    });

    it("should propagate accessTokenFromRefresh errors with original message", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "user-refresh-token",
      });
      
      mockAccessTokenFromRefresh.mockRejectedValueOnce(new Error("Token expired"));
      
      await expect(getEbayAccessTokenStrict("user123")).rejects.toThrow("Token expired");
    });

    it("should use admin mode when no userId provided", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "admin-access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessTokenStrict();
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-refresh-token", expect.any(Array));
      expect(result.token).toBe("admin-access-token");
    });

    it("should fall back to global blob in admin mode", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      delete process.env.EBAY_REFRESH_TOKEN;
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "global-blob-token",
      });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "admin-access-token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      const result = await getEbayAccessTokenStrict();
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("global-blob-token", expect.any(Array));
      expect(result.token).toBe("admin-access-token");
    });

    it("should throw error in admin mode when no token available", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      delete process.env.EBAY_REFRESH_TOKEN;
      mockStoreGet.mockResolvedValue(null);
      
      await expect(getEbayAccessTokenStrict()).rejects.toThrow(
        "EBAY_REFRESH_TOKEN env var is required"
      );
    });

    it("should handle store errors in admin mode gracefully", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      delete process.env.EBAY_REFRESH_TOKEN;
      mockStoreGet.mockRejectedValue(new Error("Store error"));
      
      await expect(getEbayAccessTokenStrict()).rejects.toThrow(
        "EBAY_REFRESH_TOKEN env var is required"
      );
    });

    it("should request all required scopes in strict mode", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "user-token",
      });
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      await getEbayAccessTokenStrict("user123");
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("user-token", [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.account',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.marketing',
      ]);
    });

    it("should handle error without message property", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "user-token",
      });
      
      mockAccessTokenFromRefresh.mockRejectedValueOnce("string error");
      
      await expect(getEbayAccessTokenStrict("user123")).rejects.toThrow(
        "string error"
      );
    });

    it("should handle null error", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: "user-token",
      });
      
      mockAccessTokenFromRefresh.mockRejectedValueOnce(null);
      
      await expect(getEbayAccessTokenStrict("user123")).rejects.toThrow(
        "No eBay token for this user. Connect eBay in Setup."
      );
    });

    it("should trim whitespace from env var in admin mode", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      process.env.EBAY_REFRESH_TOKEN = "  env-token  ";
      
      mockAccessTokenFromRefresh.mockResolvedValueOnce({
        access_token: "token",
      });
      
      mockTokenHosts.mockReturnValueOnce({
        apiHost: "https://api.ebay.com",
      });
      
      await getEbayAccessTokenStrict();
      
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("env-token", expect.any(Array));
    });

    it("should handle non-string refresh_token in user blob", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: 12345,
      });
      
      await expect(getEbayAccessTokenStrict("user123")).rejects.toThrow(
        "No eBay token for this user. Connect eBay in Setup."
      );
    });

    it("should handle non-string refresh_token in admin blob", async () => {
      const { getEbayAccessTokenStrict } = await import("../../src/lib/ebay-auth.js");
      
      delete process.env.EBAY_REFRESH_TOKEN;
      
      mockStoreGet.mockResolvedValueOnce({
        refresh_token: false,
      });
      
      await expect(getEbayAccessTokenStrict()).rejects.toThrow(
        "EBAY_REFRESH_TOKEN env var is required"
      );
    });
  });
});
