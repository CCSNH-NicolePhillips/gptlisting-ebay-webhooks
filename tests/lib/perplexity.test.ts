import { jest } from "@jest/globals";

const mockCtor = jest.fn();

// Mock OpenAI client constructor (ESM default export)
jest.mock("openai", () => ({
  __esModule: true,
  default: class MockOpenAI {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      mockCtor(opts);
    }
  },
}));

describe("perplexity client", () => {
  beforeEach(() => {
    jest.resetModules();
    mockCtor.mockClear();
    delete process.env.PERPLEXITY_API_KEY;
  });

  it("warns and uses empty apiKey when PERPLEXITY_API_KEY is missing", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { perplexity, PERPLEXITY_MODELS } = await import("../../src/lib/perplexity.js");

    expect(warnSpy).toHaveBeenCalledWith(
      "[perplexity] Warning: PERPLEXITY_API_KEY not set. Web search calls will be skipped."
    );
    expect(mockCtor).toHaveBeenCalledWith({ apiKey: "", baseURL: "https://api.perplexity.ai" });
    expect(perplexity).toBeTruthy();
    expect(PERPLEXITY_MODELS.REASONING).toBe("sonar-reasoning");
    warnSpy.mockRestore();
  });

  it("uses provided PERPLEXITY_API_KEY without warning", async () => {
    process.env.PERPLEXITY_API_KEY = "test-key";
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { perplexity } = await import("../../src/lib/perplexity.js");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockCtor).toHaveBeenCalledWith({ apiKey: "test-key", baseURL: "https://api.perplexity.ai" });
    expect(perplexity).toBeTruthy();
    warnSpy.mockRestore();
  });
});
