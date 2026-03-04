import type { Response } from 'express';

/** Send a 200 JSON response. */
export function ok(res: Response, data: unknown): void {
  res.status(200).json(data);
}

/** Send a 400 Bad Request JSON response. */
export function badRequest(res: Response, message: string, details?: unknown): void {
  res.status(400).json({ error: message, ...(details !== undefined ? { details } : {}) });
}

/** Send a 500 Internal Server Error JSON response. */
export function serverError(res: Response, err: unknown): void {
  const message =
    err instanceof Error ? err.message : String(err ?? 'Internal server error');
  res.status(500).json({ error: message });
}
