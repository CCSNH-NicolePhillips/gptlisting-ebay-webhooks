/**
 * netlify-adapter.ts
 *
 * Utilities to call legacy Handler functions from Express routes.
 * This lets complex handlers live in src/handlers/ while being served by Express.
 */

import type { Request, Response } from 'express';
import type {
  Handler,
  HandlerEvent,
  HandlerResponse,
} from '../../../../src/types/api-handler.js';

// Re-export for consumers that import from this module
export type { Handler, HandlerEvent, HandlerResponse };

/** @deprecated Use HandlerEvent instead */
export type LegacyHandlerEvent = HandlerEvent;
/** @deprecated Use HandlerResponse instead */
export type LegacyHandlerResult = HandlerResponse;
/** @deprecated Use Handler instead */
export type LegacyHandler = Handler;

/** Build a HandlerEvent from an Express request. */
export function makeHandlerEvent(req: Request): HandlerEvent {
  const host = req.get('host') ?? 'localhost';
  const rawUrl = `${req.protocol}://${host}${req.originalUrl}`;
  const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.split('?').slice(1).join('?') : '';

  // Flatten headers (Express may have arrays for some headers)
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v != null) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }

  // Flatten query params (Express types query as string | ParsedQs | string[] | ParsedQs[])
  const queryStringParameters: Record<string, string> = {};
  const multiValueQueryStringParameters: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (Array.isArray(v)) {
      const strings = v.filter((x): x is string => typeof x === 'string');
      queryStringParameters[k] = strings[0] ?? '';
      multiValueQueryStringParameters[k] = strings;
    } else if (typeof v === 'string') {
      queryStringParameters[k] = v;
      multiValueQueryStringParameters[k] = [v];
    } else if (v != null) {
      // ParsedQs — convert to string
      queryStringParameters[k] = String(v);
      multiValueQueryStringParameters[k] = [String(v)];
    }
  }

  return {
    httpMethod: req.method,
    headers,
    body: req.body != null && typeof req.body !== 'string'
      ? JSON.stringify(req.body)
      : (req.body as string | null) ?? null,
    queryStringParameters,
    multiValueQueryStringParameters,
    path: req.path,
    rawUrl,
    rawQuery,
    isBase64Encoded: false,
    multiValueHeaders: {},
  };
}

/** @deprecated Use makeHandlerEvent instead */
export const makeNetlifyEvent = makeHandlerEvent;

/** Forward a HandlerResponse to an Express response. */
export function sendHandlerResult(res: Response, result: HandlerResponse | void | undefined): void {
  if (!result) {
    res.status(200).end();
    return;
  }
  const { statusCode = 200, body = '', headers = {} } = result;
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (v != null) res.setHeader(k, String(v));
    }
  }
  res.status(statusCode);
  if (body) {
    res.send(body);
  } else {
    res.end();
  }
}

/** @deprecated Use sendHandlerResult instead */
export const sendNetlifyResult = sendHandlerResult;

/**
 * Creates an Express route handler that wraps a Handler function.
 * Usage:
 *   router.post('/my-route', wrapHandler(myHandler));
 */
export function wrapHandler(handler: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    const event = makeHandlerEvent(req);
    const result = await handler(event, {});
    sendHandlerResult(res, result);
  };
}

/** @deprecated Use wrapHandler instead */
export const wrapNetlifyHandler = wrapHandler;
