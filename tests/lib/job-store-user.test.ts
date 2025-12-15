// Set environment variables before imports
process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token-123";

import fetch from "node-fetch";
import { listJobsForUser } from "../../src/lib/job-store-user";

// Mock dependencies
jest.mock("node-fetch", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/lib/user-keys.js", () => ({
  k: {
    job: (userId: string, suffix: string) => `job:${userId}:${suffix}`,
  },
}));

const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("job-store-user", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("listJobsForUser", () => {
    it("should list jobs for a specific user", async () => {
      const keys = ["job:user123:1", "job:user123:2"];
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
              finishedAt: 2000,
            }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "2",
              state: "running",
              startedAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-redis.upstash.io/KEYS/job%3Auser123%3A*",
        expect.any(Object)
      );
      expect(jobs).toHaveLength(2);
      expect(jobs[0].jobId).toBe("1"); // Sorted by finishedAt (2000)
      expect(jobs[1].jobId).toBe("2"); // Sorted by startedAt (1000)
    });

    it("should return empty array when no jobs found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      } as any);

      const jobs = await listJobsForUser("user-no-jobs");

      expect(jobs).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should respect limit parameter", async () => {
      const keys = Array.from({ length: 100 }, (_, i) => `job:user123:${i}`);
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

      const jobs = await listJobsForUser("user123", 10);

      expect(jobs).toHaveLength(10);
    });

    it("should filter out jobs with invalid states", async () => {
      const keys = ["job:user123:1", "job:user123:2", "job:user123:3"];
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
              finishedAt: 3000,
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
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "3",
              state: "pending",
              createdAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(2);
      expect(jobs[0].state).toBe("complete");
      expect(jobs[1].state).toBe("pending");
    });

    it("should sort by finishedAt, then startedAt, then createdAt", async () => {
      const keys = ["job:user123:1", "job:user123:2", "job:user123:3"];
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
              createdAt: 1000,
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
              state: "complete",
              finishedAt: 3000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs[0].jobId).toBe("3"); // finishedAt has priority
      expect(jobs[1].jobId).toBe("2"); // startedAt
      expect(jobs[2].jobId).toBe("1"); // createdAt
    });

    it("should skip jobs with null result", async () => {
      const keys = ["job:user123:1", "job:user123:2"];
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
            result: JSON.stringify({
              jobId: "2",
              state: "complete",
              finishedAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("2");
    });

    it("should skip jobs with empty string result", async () => {
      const keys = ["job:user123:1", "job:user123:2"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: "" }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "2",
              state: "error",
              finishedAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toBe("error");
    });

    it("should skip jobs with malformed JSON", async () => {
      const keys = ["job:user123:1", "job:user123:2"];
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
            result: JSON.stringify({
              jobId: "2",
              state: "running",
              startedAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("2");
    });

    it("should extract jobId from key when missing in data", async () => {
      const keys = ["job:user123:custom-id"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              state: "complete",
              finishedAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("custom-id");
    });

    it("should use jobId from data when present", async () => {
      const keys = ["job:user123:key-id"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "data-id",
              state: "pending",
              createdAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("data-id");
    });

    it("should handle non-array KEYS result", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "not-an-array" }),
      } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toEqual([]);
    });

    it("should convert non-string array items to strings", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: [123, null, "job:user123:valid"] }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "123",
              state: "complete",
              finishedAt: 2000,
            }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "valid",
              state: "pending",
              createdAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(2);
      expect(jobs[0].jobId).toBe("123"); // Higher timestamp
      expect(jobs[1].jobId).toBe("valid");
    });

    it("should throw error when Redis not configured", async () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      jest.resetModules();
      const { listJobsForUser: listJobsNew } = await import(
        "../../src/lib/job-store-user"
      );

      await expect(listJobsNew("user123")).rejects.toThrow(
        "Upstash Redis not configured"
      );

      process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      jest.resetModules();
    });

    it("should throw error when KEYS call fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      await expect(listJobsForUser("user123")).rejects.toThrow(
        "Upstash 500: Internal Server Error"
      );
    });

    it("should skip jobs when GET call fails", async () => {
      const keys = ["job:user123:1", "job:user123:2"];
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => "Not Found",
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "2",
              state: "complete",
              finishedAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe("2");
    });

    it("should include all job data in result", async () => {
      const keys = ["job:user123:1"];
      const jobData = {
        jobId: "1",
        state: "complete",
        finishedAt: 1000,
        result: { items: [1, 2, 3] },
        metadata: { foo: "bar" },
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: keys }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify(jobData),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        key: "job:user123:1",
        jobId: "1",
        state: "complete",
        finishedAt: 1000,
        result: { items: [1, 2, 3] },
        metadata: { foo: "bar" },
      });
    });

    it("should use default limit of 50", async () => {
      const keys = Array.from({ length: 60 }, (_, i) => `job:user123:${i}`);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: keys }),
      } as any);

      for (let i = 0; i < 60; i++) {
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

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(50);
    });

    it("should handle jobs with only createdAt timestamp", async () => {
      const keys = ["job:user123:1"];
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
              state: "pending",
              createdAt: 5000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(1);
      expect(jobs[0].createdAt).toBe(5000);
    });

    it("should handle jobs with no timestamps (defaults to 0)", async () => {
      const keys = ["job:user123:1", "job:user123:2"];
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
            }),
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            result: JSON.stringify({
              jobId: "2",
              state: "running",
              startedAt: 1000,
            }),
          }),
        } as any);

      const jobs = await listJobsForUser("user123");

      expect(jobs).toHaveLength(2);
      expect(jobs[0].jobId).toBe("2"); // Has timestamp
      expect(jobs[1].jobId).toBe("1"); // No timestamp (0)
    });
  });
});
