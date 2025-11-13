// Tests for ingestion adapter registry

import {
  getAdapter,
  getSupportedSources,
  isSourceSupported,
  IngestError,
  IngestErrorCode,
} from "../../src/ingestion/index.js";

describe("Adapter Registry", () => {
  test("getSupportedSources returns array", () => {
    const sources = getSupportedSources();
    expect(Array.isArray(sources)).toBe(true);
    expect(sources.length).toBeGreaterThan(0);
  });

  test("local adapter is supported", () => {
    expect(isSourceSupported("local")).toBe(true);
    const adapter = getAdapter("local");
    expect(adapter).toBeDefined();
    expect(typeof adapter.list).toBe("function");
    expect(typeof adapter.stage).toBe("function");
  });

  test("dropbox adapter is supported", () => {
    expect(isSourceSupported("dropbox")).toBe(true);
    const adapter = getAdapter("dropbox");
    expect(adapter).toBeDefined();
    expect(typeof adapter.list).toBe("function");
  });

  test("unsupported source returns false", () => {
    expect(isSourceSupported("ftp" as any)).toBe(false);
    expect(isSourceSupported("invalid" as any)).toBe(false);
  });

  test("getAdapter throws for unsupported source", () => {
    expect(() => getAdapter("ftp" as any)).toThrow(IngestError);
    expect(() => getAdapter("ftp" as any)).toThrow(/not supported/i);
  });

  test("getAdapter error has correct code", () => {
    try {
      getAdapter("invalid" as any);
      fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(IngestError);
      expect(err.code).toBe(IngestErrorCode.INVALID_SOURCE);
    }
  });
});
