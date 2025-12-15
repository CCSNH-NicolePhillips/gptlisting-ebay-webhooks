// Mock OpenAI before importing module
jest.mock("openai");

describe("openai module", () => {
  let originalApiKey: string | undefined;
  let consoleWarnSpy: jest.SpyInstance;

  beforeAll(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  afterAll(() => {
    if (originalApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("should create OpenAI client with API key from environment", async () => {
    process.env.OPENAI_API_KEY = "test-api-key-123";
    
    const OpenAI = (await import("openai")).default;
    const { openai } = await import("../../src/lib/openai");

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "test-api-key-123",
      defaultHeaders: { "User-Agent": "draftpilot-ai-product-analyzer/1.0" },
    });
    expect(openai).toBeDefined();
  });

  it("should warn when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;

    await import("../../src/lib/openai");

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[openai] Warning: OPENAI_API_KEY not set. Vision calls will fail."
    );
  });

  it("should create OpenAI client with empty string when API key is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    const OpenAI = (await import("openai")).default;
    const { openai } = await import("../../src/lib/openai");

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "",
      defaultHeaders: { "User-Agent": "draftpilot-ai-product-analyzer/1.0" },
    });
    expect(openai).toBeDefined();
  });

  it("should set custom User-Agent header", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = (await import("openai")).default;
    await import("../../src/lib/openai");

    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: { "User-Agent": "draftpilot-ai-product-analyzer/1.0" },
      })
    );
  });

  it("should not warn when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "valid-key";

    await import("../../src/lib/openai");

    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("should handle empty string API key as missing", async () => {
    process.env.OPENAI_API_KEY = "";

    const OpenAI = (await import("openai")).default;
    await import("../../src/lib/openai");

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[openai] Warning: OPENAI_API_KEY not set. Vision calls will fail."
    );
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "",
      defaultHeaders: { "User-Agent": "draftpilot-ai-product-analyzer/1.0" },
    });
  });
});
