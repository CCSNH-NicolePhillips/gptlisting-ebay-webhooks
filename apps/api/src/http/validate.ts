/**
 * validate.ts — Shared request-validation utilities for Express routes.
 *
 * Centralises the "is this required field present?" pattern so each route
 * doesn't repeat the same if-guards.
 */

/**
 * Check that all `required` keys are non-empty strings / non-null values in `source`.
 *
 * @returns `null` when all fields are present, or the name of the first missing
 *          field as a human-readable error string.
 *
 * @example
 * const err = missingField(req.body, ['offerId', 'sku']);
 * if (err) return badRequest(res, err);
 */
export function missingField(
  source: Record<string, unknown>,
  required: string[],
): string | null {
  for (const field of required) {
    const v = source[field];
    if (v === undefined || v === null || v === '') {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}

/**
 * Return `true` if the value is a non-empty string after trimming.
 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
