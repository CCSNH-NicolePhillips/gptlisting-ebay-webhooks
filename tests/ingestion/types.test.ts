// Tests for ingestion type system and error handling

import { IngestError, IngestErrorCode } from "../../src/ingestion/types.js";

describe("IngestError", () => {
  test("creates error with code and message", () => {
    const err = new IngestError(IngestErrorCode.INVALID_SOURCE, "Bad source");
    expect(err.code).toBe(IngestErrorCode.INVALID_SOURCE);
    expect(err.message).toBe("Bad source");
    expect(err.name).toBe("IngestError");
  });

  test("includes details when provided", () => {
    const details = { requested: 300, maxFiles: 200 };
    const err = new IngestError(
      IngestErrorCode.QUOTA_EXCEEDED,
      "Too many files",
      details
    );
    expect(err.details).toEqual(details);
  });

  test("works without details", () => {
    const err = new IngestError(IngestErrorCode.STAGING_FAILED, "Upload failed");
    expect(err.details).toBeUndefined();
  });

  test("has correct error codes", () => {
    expect(IngestErrorCode.INVALID_SOURCE).toBe("INVALID_SOURCE");
    expect(IngestErrorCode.QUOTA_EXCEEDED).toBe("QUOTA_EXCEEDED");
    expect(IngestErrorCode.STAGING_FAILED).toBe("STAGING_FAILED");
    expect(IngestErrorCode.AUTH_FAILED).toBe("AUTH_FAILED");
    expect(IngestErrorCode.INVALID_FILE_TYPE).toBe("INVALID_FILE_TYPE");
    expect(IngestErrorCode.FILE_TOO_LARGE).toBe("FILE_TOO_LARGE");
  });
});
