// Set environment variables before imports
process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token-123";

import fetch from "node-fetch";
import {
  putJob,
  getJob,
  listJobs,
  redisSet,
  clearKeysByPattern,
  clearUserJobs,
} from "../../src/lib/job-store";

// Mock node-fetch
jest.mock("node-fetch", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("job-store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("redisSet", () => {
    it("should set a key with custom TTL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await redisSet("test:key", "test-value", 3600);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-redis.upstash.io/SETEX/test%3Akey/3600/test-value",
        {
          method: "POST",
          headers: { Authorization: "Bearer test-token-123" },
        }
      );
    });

    it("should handle special characters in key and value", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await redisSet("key:with:colons", "value with spaces", 1800);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("key%3Awith%3Acolons"),
        expect.any(Object)
      );
    });

    it("should throw error when Redis is not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      // Re-import to get new config
      jest.resetModules();
      const { redisSet: redisSetNew } = await import("../../src/lib/job-store");

      await expect(redisSetNew("test", "value", 100)).rejects.toThrow(
        "Upstash Redis not configured"
      );

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });

    it("should throw error when Redis call fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      await expect(redisSet("test", "value", 100)).rejects.toThrow(
        "Redis error 500: Internal Server Error"
      );
    });
  });

  describe("putJob", () => {
    it("should store job with default key", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      const jobData = { state: "pending", userId: "user123" };
      await putJob("job-123", jobData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("SETEX/job%3Ajob-123/172800"),
        expect.any(Object)
      );
    });

    it("should store job with custom key and fallback", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      const jobData = { state: "running", progress: 50 };
      await putJob("job-456", jobData, { key: "custom:job:456" });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("custom%3Ajob%3A456"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("job%3Ajob-456"),
        expect.any(Object)
      );
    });

    it("should serialize complex job data", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      const jobData = {
        state: "complete",
        result: { items: [1, 2, 3] },
        metadata: { foo: "bar" },
      };
      await putJob("job-789", jobData);

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(encodeURIComponent(JSON.stringify(jobData)));
    });

    it("should not duplicate storage when custom key equals default", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await putJob("job-999", { state: "pending" }, { key: "job:job-999" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should handle null and undefined in job data", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "OK" }),
      } as any);

      await putJob("job-null", { value: null, undef: undefined });

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("getJob", () => {
    it("should retrieve job with default key", async () => {
      const jobData = { state: "complete", result: "success" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(jobData) }),
      } as any);

      const result = await getJob("job-123");

      expect(result).toEqual(jobData);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("GET/job%3Ajob-123"),
        expect.any(Object)
      );
    });

    it("should retrieve job with custom key first", async () => {
      const jobData = { state: "running", progress: 75 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(jobData) }),
      } as any);

      const result = await getJob("job-456", { key: "custom:job:456" });

      expect(result).toEqual(jobData);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("GET/custom%3Ajob%3A456"),
        expect.any(Object)
      );
    });

    it("should fallback to default key when custom key fails", async () => {
      const jobData = { state: "error", error: "Failed" };
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => "Not found",
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: JSON.stringify(jobData) }),
        } as any);

      const result = await getJob("job-789", { key: "custom:missing" });

      expect(result).toEqual(jobData);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should return null when job not found", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: null }),
      } as any);

      const result = await getJob("nonexistent");

      expect(result).toBeNull();
    });

    it("should return null when result is empty string", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "" }),
      } as any);

      const result = await getJob("job-empty");

      expect(result).toBeNull();
    });

    it("should return null when JSON parsing fails", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: "invalid-json{" }),
      } as any);

      const result = await getJob("job-invalid");

      expect(result).toBeNull();
    });

    it("should handle all keys failing", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await getJob("job-error", { key: "custom:error" });

      expect(result).toBeNull();
    });

    it("should skip duplicate keys in fallback list", async () => {
      const jobData = { state: "pending" };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: JSON.stringify(jobData) }),
      } as any);

      await getJob("job-123", { key: "job:job-123" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("listJobs", () => {
    it("should list jobs sorted by timestamp", async () => {
      const keys = ["job:1", "job:2", "job:3"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "1",
              state: "complete",
              finishedAt: 1000,
            }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "2",
              state: "running",
              startedAt: 2000,
            }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "3",
              state: "pending",
              createdAt: 3000,
            }),
          }),
        } as any);

      const jobs = await listJobs();

      expect(jobs).toHaveLength(3);
      expect(jobs[0].jobId).toBe("3");
      expect(jobs[1].jobId).toBe("2");
      expect(jobs[2].jobId).toBe("1");
    });

    it("should respect limit parameter", async () => {
      const keys = Array.from({ length: 100 }, (_, i) => `job:${i}`);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: keys }),
      } as any);

      // Mock all GET calls
      for (let i = 0; i < 100; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: String(i),
              state: "complete",
              finishedAt: i,
            }),
          }),
        } as any);
      }

      const jobs = await listJobs(10);

      expect(jobs).toHaveLength(10);
    });

    it("should return empty array when no jobs found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      } as any);

      const jobs = await listJobs();

      expect(jobs).toEqual([]);
    });

    it("should filter out jobs with invalid states", async () => {
      const keys = ["job:1", "job:2"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "1",
              state: "complete",
              finishedAt: 1000,
            }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "2",
              state: "invalid-state",
              createdAt: 2000,
            }),
          }),
        } as any);

      const jobs = await listJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toBe("complete");
    });

    it("should handle missing jobId in parsed data", async () => {
      const keys = ["job:123"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({ state: "complete", finishedAt: 1000 }),
          }),
        } as any);

      const jobs = await listJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("123");
    });

    it("should extract jobId from key when not in data", async () => {
      const keys = ["custom:key:456"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({ state: "running", startedAt: 1000 }),
          }),
        } as any);

      const jobs = await listJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("custom:key:456");
    });

    it("should skip jobs with null or empty result", async () => {
      const keys = ["job:1", "job:2"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: null }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({ jobId: "2", state: "complete", finishedAt: 1000 }),
          }),
        } as any);

      const jobs = await listJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("2");
    });

    it("should skip jobs with malformed JSON", async () => {
      const keys = ["job:1", "job:2"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "invalid-json{" }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({ jobId: "2", state: "error", finishedAt: 1000 }),
          }),
        } as any);

      const jobs = await listJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("2");
    });

    it("should handle non-array result from KEYS", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "not-an-array" }),
      } as any);

      const jobs = await listJobs();

      expect(jobs).toEqual([]);
    });

    it("should convert non-string array items to strings", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [123, null, "job:valid"] }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ jobId: "123", state: "complete", finishedAt: 1000 }),
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: JSON.stringify({ jobId: "valid", state: "pending", createdAt: 500 }),
        }),
      } as any);

      const jobs = await listJobs();

      expect(jobs).toHaveLength(2);
      expect(jobs[0].jobId).toBe("123"); // Higher timestamp
      expect(jobs[1].jobId).toBe("valid");
    });

    it("should sort by finishedAt, then startedAt, then createdAt", async () => {
      const keys = ["job:1", "job:2", "job:3"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({ jobId: "1", state: "complete", createdAt: 1000 }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({ jobId: "2", state: "running", startedAt: 2000 }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({ jobId: "3", state: "complete", finishedAt: 3000 }),
          }),
        } as any);

      const jobs = await listJobs();

      expect(jobs[0].jobId).toBe("3"); // finishedAt has priority
      expect(jobs[1].jobId).toBe("2"); // startedAt
      expect(jobs[2].jobId).toBe("1"); // createdAt
    });
  });

  describe("clearKeysByPattern", () => {
    it("should delete all keys matching pattern", async () => {
      const keys = ["job:user1:1", "job:user1:2", "job:user1:3"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValue({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any);

      const deleted = await clearKeysByPattern("job:user1:*");

      expect(deleted).toBe(3);
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 KEYS + 3 DEL
    });

    it("should return 0 when no keys match pattern", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      } as any);

      const deleted = await clearKeysByPattern("nonexistent:*");

      expect(deleted).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only KEYS
    });

    it("should continue deleting even if some fail", async () => {
      const keys = ["key1", "key2", "key3"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any)
        .mockRejectedValueOnce(new Error("Delete failed"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any);

      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();

      const deleted = await clearKeysByPattern("key*");

      expect(deleted).toBe(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to delete key key2:",
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it("should handle non-string keys in result", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: [123, null, "valid:key"] }),
        } as any)
        .mockResolvedValue({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any);

      const deleted = await clearKeysByPattern("*");

      expect(deleted).toBe(2); // "123" and "valid:key"
    });
  });

  describe("clearUserJobs", () => {
    it("should clear all user-related keys", async () => {
      // Mock KEYS responses for each pattern
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: ["job:user123:1", "job:user123:2"] }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: ["price:user123:1"] }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: ["taxo:ovr:user123:1"] }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: ["jobsidx:user123"] }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: 1 }),
        } as any);

      const total = await clearUserJobs("user123");

      expect(total).toBe(5); // 2 jobs + 1 price + 1 override + 1 index
    });

    it("should return 0 when user has no keys", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      } as any);

      const total = await clearUserJobs("nonexistent-user");

      expect(total).toBe(0);
    });

    it("should clear each key type pattern", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      } as any);

      await clearUserJobs("user456");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("job%3Auser456%3A*"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("price%3Auser456%3A*"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("taxo%3Aovr%3Auser456%3A*"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("jobsidx%3Auser456"),
        expect.any(Object)
      );
    });
  });
});
