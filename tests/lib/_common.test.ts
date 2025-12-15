// Set environment variables before imports
process.env.EBAY_CLIENT_ID = "test-client-id";
process.env.EBAY_CLIENT_SECRET = "test-client-secret";

import {
  resolveEbayEnv,
  tokenHosts,
  accessTokenFromRefresh,
  appAccessToken,
} from "../../src/lib/_common";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("_common", () => {
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

  describe("resolveEbayEnv", () => {
    it("should resolve 'prod' to 'production'", () => {
      expect(resolveEbayEnv("prod")).toBe("production");
    });

    it("should resolve 'production' to 'production'", () => {
      expect(resolveEbayEnv("production")).toBe("production");
    });

    it("should resolve 'live' to 'production'", () => {
      expect(resolveEbayEnv("live")).toBe("production");
    });

    it("should resolve 'sb' to 'sandbox'", () => {
      expect(resolveEbayEnv("sb")).toBe("sandbox");
    });

    it("should resolve 'sandbox' to 'sandbox'", () => {
      expect(resolveEbayEnv("sandbox")).toBe("sandbox");
    });

    it("should resolve 'san' to 'sandbox'", () => {
      expect(resolveEbayEnv("san")).toBe("sandbox");
    });

    it("should default to 'production' for undefined", () => {
      expect(resolveEbayEnv(undefined)).toBe("production");
    });

    it("should default to 'production' for empty string", () => {
      expect(resolveEbayEnv("")).toBe("production");
    });

    it("should default to 'production' for unrecognized value", () => {
      expect(resolveEbayEnv("unknown")).toBe("production");
    });

    it("should handle case insensitivity", () => {
      expect(resolveEbayEnv("PROD")).toBe("production");
      expect(resolveEbayEnv("SANDBOX")).toBe("sandbox");
      expect(resolveEbayEnv("PrOd")).toBe("production");
    });

    it("should trim whitespace", () => {
      expect(resolveEbayEnv("  prod  ")).toBe("production");
      expect(resolveEbayEnv("  sandbox  ")).toBe("sandbox");
    });

    it("should handle whitespace-only string as production", () => {
      expect(resolveEbayEnv("   ")).toBe("production");
    });
  });

  describe("tokenHosts", () => {
    it("should return production hosts by default", () => {
      delete process.env.EBAY_ENDPOINT_URL;
      delete process.env.EBAY_API_HOST;

      const hosts = tokenHosts(undefined);

      expect(hosts).toEqual({
        tokenHost: "https://api.ebay.com",
        apiHost: "https://api.ebay.com",
      });
    });

    it("should return production hosts for 'prod'", () => {
      delete process.env.EBAY_ENDPOINT_URL;
      delete process.env.EBAY_API_HOST;

      const hosts = tokenHosts("prod");

      expect(hosts.tokenHost).toBe("https://api.ebay.com");
      expect(hosts.apiHost).toBe("https://api.ebay.com");
    });

    it("should return sandbox hosts for 'sandbox'", () => {
      delete process.env.EBAY_ENDPOINT_URL;
      delete process.env.EBAY_API_HOST;

      const hosts = tokenHosts("sandbox");

      expect(hosts).toEqual({
        tokenHost: "https://api.sandbox.ebay.com",
        apiHost: "https://api.sandbox.ebay.com",
      });
    });

    it("should use EBAY_API_HOST when set", () => {
      process.env.EBAY_API_HOST = "https://custom.ebay.com";
      delete process.env.EBAY_ENDPOINT_URL;

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://custom.ebay.com");
    });

    it("should prefer EBAY_API_HOST over EBAY_ENDPOINT_URL", () => {
      process.env.EBAY_API_HOST = "https://api-host.ebay.com";
      process.env.EBAY_ENDPOINT_URL = "https://endpoint.ebay.com";

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://api-host.ebay.com");
    });

    it("should use EBAY_ENDPOINT_URL when EBAY_API_HOST not set", () => {
      delete process.env.EBAY_API_HOST;
      process.env.EBAY_ENDPOINT_URL = "https://endpoint.ebay.com/path";

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://endpoint.ebay.com");
    });

    it("should ignore EBAY_ENDPOINT_URL without ebay.com in hostname", () => {
      delete process.env.EBAY_API_HOST;
      process.env.EBAY_ENDPOINT_URL = "https://example.com";

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://api.ebay.com");
    });

    it("should ignore invalid EBAY_ENDPOINT_URL", () => {
      delete process.env.EBAY_API_HOST;
      process.env.EBAY_ENDPOINT_URL = "not-a-valid-url";

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://api.ebay.com");
    });

    it("should handle EBAY_ENDPOINT_URL with port", () => {
      delete process.env.EBAY_API_HOST;
      process.env.EBAY_ENDPOINT_URL = "https://api.ebay.com:8080/path";

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://api.ebay.com:8080");
    });

    it("should trim whitespace from environment variables", () => {
      process.env.EBAY_API_HOST = "  https://trimmed.ebay.com  ";
      delete process.env.EBAY_ENDPOINT_URL;

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://trimmed.ebay.com");
    });

    it("should ignore empty EBAY_API_HOST", () => {
      process.env.EBAY_API_HOST = "";
      process.env.EBAY_ENDPOINT_URL = "https://endpoint.ebay.com";

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://endpoint.ebay.com");
    });

    it("should handle sandbox with custom endpoint", () => {
      delete process.env.EBAY_API_HOST;
      process.env.EBAY_ENDPOINT_URL = "https://custom.sandbox.ebay.com";

      const hosts = tokenHosts("sandbox");

      expect(hosts.tokenHost).toBe("https://api.sandbox.ebay.com");
      expect(hosts.apiHost).toBe("https://custom.sandbox.ebay.com");
    });

    it("should handle case-insensitive hostname check", () => {
      delete process.env.EBAY_API_HOST;
      process.env.EBAY_ENDPOINT_URL = "https://API.EBAY.COM";

      const hosts = tokenHosts("prod");

      expect(hosts.apiHost).toBe("https://api.ebay.com");
    });
  });

  describe("accessTokenFromRefresh", () => {
    it("should request new access token with default scopes", async () => {
      process.env.EBAY_ENV = "production";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "new-access-token",
          expires_in: 7200,
        }),
      } as any);

      const result = await accessTokenFromRefresh("refresh-token-123");

      expect(result.access_token).toBe("new-access-token");
      expect(result.expires_in).toBe(7200);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/identity/v1/oauth2/token",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        })
      );
    });

    it("should use custom scopes when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "custom-scope-token",
          expires_in: 3600,
        }),
      } as any);

      const customScopes = ["https://api.ebay.com/oauth/api_scope/sell.inventory"];
      await accessTokenFromRefresh("refresh-123", customScopes);

      const callBody = mockFetch.mock.calls[0][1].body;
      expect(callBody.toString()).toContain(
        encodeURIComponent("https://api.ebay.com/oauth/api_scope/sell.inventory")
      );
    });

    it("should use sandbox token host when EBAY_ENV is sandbox", async () => {
      process.env.EBAY_ENV = "sandbox";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "sandbox-token",
          expires_in: 7200,
        }),
      } as any);

      await accessTokenFromRefresh("refresh-sandbox");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
        expect.any(Object)
      );
    });

    it("should include Basic auth header with client credentials", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "token",
          expires_in: 7200,
        }),
      } as any);

      await accessTokenFromRefresh("refresh-123");

      const expectedAuth = Buffer.from("test-client-id:test-client-secret").toString(
        "base64"
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${expectedAuth}`,
          }),
        })
      );
    });

    it("should include refresh_token in request body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "token",
          expires_in: 7200,
        }),
      } as any);

      await accessTokenFromRefresh("my-refresh-token");

      const callBody = mockFetch.mock.calls[0][1].body.toString();
      expect(callBody).toContain("refresh_token=my-refresh-token");
      expect(callBody).toContain("grant_type=refresh_token");
    });

    it("should throw error when token refresh fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Invalid refresh token",
      } as any);

      await expect(accessTokenFromRefresh("bad-refresh-token")).rejects.toThrow(
        "token refresh failed: 401 Invalid refresh token"
      );
    });

    it("should handle empty scopes array by using defaults", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "default-scopes-token",
          expires_in: 7200,
        }),
      } as any);

      await accessTokenFromRefresh("refresh-123", []);

      const callBody = mockFetch.mock.calls[0][1].body.toString();
      // Empty array should trigger default scopes
      expect(callBody).toContain("https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope");
    });

    it("should handle multiple custom scopes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "multi-scope-token",
          expires_in: 7200,
        }),
      } as any);

      const scopes = [
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.account",
      ];
      await accessTokenFromRefresh("refresh-123", scopes);

      const callBody = mockFetch.mock.calls[0][1].body.toString();
      expect(callBody).toContain("sell.inventory");
      expect(callBody).toContain("sell.account");
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(accessTokenFromRefresh("refresh-123")).rejects.toThrow(
        "Network error"
      );
    });
  });

  describe("appAccessToken", () => {
    it("should request app access token with provided scopes", async () => {
      process.env.EBAY_ENV = "production";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "app-access-token",
          expires_in: 7200,
        }),
      } as any);

      const scopes = ["https://api.ebay.com/oauth/api_scope"];
      const result = await appAccessToken(scopes);

      expect(result.access_token).toBe("app-access-token");
      expect(result.expires_in).toBe(7200);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/identity/v1/oauth2/token",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    it("should use sandbox token host when EBAY_ENV is sandbox", async () => {
      process.env.EBAY_ENV = "sandbox";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "sandbox-app-token",
          expires_in: 7200,
        }),
      } as any);

      await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
        expect.any(Object)
      );
    });

    it("should include Basic auth header with client credentials", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "token",
          expires_in: 7200,
        }),
      } as any);

      await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);

      const expectedAuth = Buffer.from("test-client-id:test-client-secret").toString(
        "base64"
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${expectedAuth}`,
          }),
        })
      );
    });

    it("should use client_credentials grant type", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "token",
          expires_in: 7200,
        }),
      } as any);

      await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);

      const callBody = mockFetch.mock.calls[0][1].body.toString();
      expect(callBody).toContain("grant_type=client_credentials");
    });

    it("should include scopes in request body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "token",
          expires_in: 7200,
        }),
      } as any);

      const scopes = [
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.account",
      ];
      await appAccessToken(scopes);

      const callBody = mockFetch.mock.calls[0][1].body.toString();
      expect(callBody).toContain("sell.inventory");
      expect(callBody).toContain("sell.account");
    });

    it("should throw error when app token request fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Invalid client credentials",
      } as any);

      await expect(
        appAccessToken(["https://api.ebay.com/oauth/api_scope"])
      ).rejects.toThrow("app token failed: 403 Invalid client credentials");
    });

    it("should handle empty scopes array", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "empty-scope-token",
          expires_in: 7200,
        }),
      } as any);

      await appAccessToken([]);

      const callBody = mockFetch.mock.calls[0][1].body.toString();
      expect(callBody).toContain("scope=");
    });

    it("should set Content-Type header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "token",
          expires_in: 7200,
        }),
      } as any);

      await appAccessToken(["https://api.ebay.com/oauth/api_scope"]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        })
      );
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network failure"));

      await expect(
        appAccessToken(["https://api.ebay.com/oauth/api_scope"])
      ).rejects.toThrow("Network failure");
    });
  });
});
