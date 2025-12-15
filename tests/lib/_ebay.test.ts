// Mock dependencies
jest.mock("../../src/lib/_blobs.js");
jest.mock("../../src/lib/_common.js");
jest.mock("../../src/lib/_auth.js");

import { getUserAccessToken, apiHost, headers } from "../../src/lib/_ebay";
import { tokensStore } from "../../src/lib/_blobs.js";
import { accessTokenFromRefresh, tokenHosts } from "../../src/lib/_common.js";
import { userScopedKey } from "../../src/lib/_auth.js";

const mockTokensStore = tokensStore as jest.MockedFunction<typeof tokensStore>;
const mockAccessTokenFromRefresh = accessTokenFromRefresh as jest.MockedFunction<
  typeof accessTokenFromRefresh
>;
const mockTokenHosts = tokenHosts as jest.MockedFunction<typeof tokenHosts>;
const mockUserScopedKey = userScopedKey as jest.MockedFunction<typeof userScopedKey>;

describe("_ebay", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("getUserAccessToken", () => {
    it("should retrieve access token for user", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "refresh-token-123",
          access_token: "old-access-token",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:sub123:ebay.json");
      mockAccessTokenFromRefresh.mockResolvedValue({
        access_token: "new-access-token",
        expires_in: 7200,
      } as any);

      const token = await getUserAccessToken("sub123");

      expect(token).toBe("new-access-token");
      expect(mockUserScopedKey).toHaveBeenCalledWith("sub123", "ebay.json");
      expect(mockStore.get).toHaveBeenCalledWith("user:sub123:ebay.json", {
        type: "json",
      });
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith(
        "refresh-token-123",
        undefined
      );
    });

    it("should pass scopes to accessTokenFromRefresh", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "refresh-token-456",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:sub456:ebay.json");
      mockAccessTokenFromRefresh.mockResolvedValue({
        access_token: "scoped-access-token",
      } as any);

      const scopes = ["https://api.ebay.com/oauth/api_scope/sell.inventory"];
      const token = await getUserAccessToken("sub456", scopes);

      expect(token).toBe("scoped-access-token");
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith(
        "refresh-token-456",
        scopes
      );
    });

    it("should throw error when refresh token not found", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue(null),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:sub789:ebay.json");

      await expect(getUserAccessToken("sub789")).rejects.toThrow(
        "ebay-not-connected"
      );
    });

    it("should throw error when saved data has no refresh_token", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          access_token: "some-token",
          // no refresh_token
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:sub999:ebay.json");

      const error = await getUserAccessToken("sub999").catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("ebay-not-connected");
      expect(error.code).toBe("ebay-not-connected");
    });

    it("should throw error when access token minting fails", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "refresh-token-fail",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:subfail:ebay.json");
      mockAccessTokenFromRefresh.mockResolvedValue({
        // no access_token returned
        expires_in: 7200,
      } as any);

      await expect(getUserAccessToken("subfail")).rejects.toThrow(
        "failed-to-mint-access-token"
      );
    });

    it("should throw error when accessTokenFromRefresh returns null", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "refresh-token-null",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:subnull:ebay.json");
      mockAccessTokenFromRefresh.mockResolvedValue(null as any);

      await expect(getUserAccessToken("subnull")).rejects.toThrow(
        "Cannot destructure"
      );
    });

    it("should handle empty scopes array", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "refresh-token-empty",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:subempty:ebay.json");
      mockAccessTokenFromRefresh.mockResolvedValue({
        access_token: "empty-scopes-token",
      } as any);

      const token = await getUserAccessToken("subempty", []);

      expect(token).toBe("empty-scopes-token");
      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith(
        "refresh-token-empty",
        []
      );
    });

    it("should handle multiple scopes", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "refresh-multi",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:submulti:ebay.json");
      mockAccessTokenFromRefresh.mockResolvedValue({
        access_token: "multi-scope-token",
      } as any);

      const scopes = [
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.account",
      ];
      await getUserAccessToken("submulti", scopes);

      expect(mockAccessTokenFromRefresh).toHaveBeenCalledWith("refresh-multi", scopes);
    });

    it("should handle refresh_token as only property in saved data", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "only-refresh",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:subonly:ebay.json");
      mockAccessTokenFromRefresh.mockResolvedValue({
        access_token: "only-access",
      } as any);

      const token = await getUserAccessToken("subonly");

      expect(token).toBe("only-access");
    });

    it("should propagate errors from store.get", async () => {
      const mockStore = {
        get: jest.fn().mockRejectedValue(new Error("Store error")),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:suberr:ebay.json");

      await expect(getUserAccessToken("suberr")).rejects.toThrow("Store error");
    });

    it("should propagate errors from accessTokenFromRefresh", async () => {
      const mockStore = {
        get: jest.fn().mockResolvedValue({
          refresh_token: "refresh-err",
        }),
      };

      mockTokensStore.mockReturnValue(mockStore as any);
      mockUserScopedKey.mockReturnValue("user:subrefresh:ebay.json");
      mockAccessTokenFromRefresh.mockRejectedValue(new Error("Refresh failed"));

      await expect(getUserAccessToken("subrefresh")).rejects.toThrow("Refresh failed");
    });
  });

  describe("apiHost", () => {
    it("should return production API host by default", () => {
      delete process.env.EBAY_ENV;
      mockTokenHosts.mockReturnValue({
        apiHost: "https://api.ebay.com",
        authHost: "https://auth.ebay.com",
      } as any);

      const host = apiHost();

      expect(host).toBe("https://api.ebay.com");
      expect(mockTokenHosts).toHaveBeenCalledWith("PROD");
    });

    it("should use EBAY_ENV when set", () => {
      process.env.EBAY_ENV = "SANDBOX";
      mockTokenHosts.mockReturnValue({
        apiHost: "https://api.sandbox.ebay.com",
        authHost: "https://auth.sandbox.ebay.com",
      } as any);

      const host = apiHost();

      expect(host).toBe("https://api.sandbox.ebay.com");
      expect(mockTokenHosts).toHaveBeenCalledWith("SANDBOX");
    });

    it("should handle PROD environment explicitly", () => {
      process.env.EBAY_ENV = "PROD";
      mockTokenHosts.mockReturnValue({
        apiHost: "https://api.ebay.com",
        authHost: "https://auth.ebay.com",
      } as any);

      const host = apiHost();

      expect(host).toBe("https://api.ebay.com");
      expect(mockTokenHosts).toHaveBeenCalledWith("PROD");
    });

    it("should handle custom environment values", () => {
      process.env.EBAY_ENV = "CUSTOM";
      mockTokenHosts.mockReturnValue({
        apiHost: "https://api.custom.ebay.com",
        authHost: "https://auth.custom.ebay.com",
      } as any);

      const host = apiHost();

      expect(host).toBe("https://api.custom.ebay.com");
      expect(mockTokenHosts).toHaveBeenCalledWith("CUSTOM");
    });

    it("should call tokenHosts with environment", () => {
      process.env.EBAY_ENV = "TEST";
      mockTokenHosts.mockReturnValue({
        apiHost: "https://api.test.ebay.com",
        authHost: "https://auth.test.ebay.com",
      } as any);

      apiHost();

      expect(mockTokenHosts).toHaveBeenCalledTimes(1);
      expect(mockTokenHosts).toHaveBeenCalledWith("TEST");
    });
  });

  describe("headers", () => {
    it("should generate headers with default marketplace", () => {
      delete process.env.DEFAULT_MARKETPLACE_ID;
      delete process.env.EBAY_MARKETPLACE_ID;

      const result = headers("test-token-123");

      expect(result).toEqual({
        Authorization: "Bearer test-token-123",
        Accept: "application/json",
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "Content-Type": "application/json",
      });
    });

    it("should use DEFAULT_MARKETPLACE_ID when set", () => {
      process.env.DEFAULT_MARKETPLACE_ID = "EBAY_UK";

      const result = headers("test-token-456");

      expect(result["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_UK");
    });

    it("should use EBAY_MARKETPLACE_ID when DEFAULT_MARKETPLACE_ID not set", () => {
      delete process.env.DEFAULT_MARKETPLACE_ID;
      process.env.EBAY_MARKETPLACE_ID = "EBAY_DE";

      const result = headers("test-token-789");

      expect(result["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_DE");
    });

    it("should prefer DEFAULT_MARKETPLACE_ID over EBAY_MARKETPLACE_ID", () => {
      process.env.DEFAULT_MARKETPLACE_ID = "EBAY_FR";
      process.env.EBAY_MARKETPLACE_ID = "EBAY_IT";

      const result = headers("test-token-pref");

      expect(result["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_FR");
    });

    it("should include Bearer token in Authorization header", () => {
      const result = headers("my-secret-token");

      expect(result.Authorization).toBe("Bearer my-secret-token");
    });

    it("should include all required headers", () => {
      const result = headers("token");

      expect(result).toHaveProperty("Authorization");
      expect(result).toHaveProperty("Accept");
      expect(result).toHaveProperty("Content-Language");
      expect(result).toHaveProperty("Accept-Language");
      expect(result).toHaveProperty("X-EBAY-C-MARKETPLACE-ID");
      expect(result).toHaveProperty("Content-Type");
    });

    it("should set Content-Type to application/json", () => {
      const result = headers("token");

      expect(result["Content-Type"]).toBe("application/json");
    });

    it("should set Accept to application/json", () => {
      const result = headers("token");

      expect(result.Accept).toBe("application/json");
    });

    it("should set language headers to en-US", () => {
      const result = headers("token");

      expect(result["Content-Language"]).toBe("en-US");
      expect(result["Accept-Language"]).toBe("en-US");
    });

    it("should handle empty token string", () => {
      const result = headers("");

      expect(result.Authorization).toBe("Bearer ");
    });

    it("should handle tokens with special characters", () => {
      const specialToken = "abc-123_xyz.token$special";
      const result = headers(specialToken);

      expect(result.Authorization).toBe(`Bearer ${specialToken}`);
    });

    it("should handle very long tokens", () => {
      const longToken = "a".repeat(1000);
      const result = headers(longToken);

      expect(result.Authorization).toBe(`Bearer ${longToken}`);
    });

    it("should support various marketplace IDs", () => {
      const marketplaces = ["EBAY_US", "EBAY_UK", "EBAY_DE", "EBAY_AU", "EBAY_CA"];

      for (const marketplace of marketplaces) {
        process.env.DEFAULT_MARKETPLACE_ID = marketplace;
        const result = headers("token");
        expect(result["X-EBAY-C-MARKETPLACE-ID"]).toBe(marketplace);
      }
    });
  });
});
