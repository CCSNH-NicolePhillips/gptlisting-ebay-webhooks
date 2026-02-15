/**
 * API Handler Types
 * 
 * Clean handler interface for serverless-style functions.
 * Each handler receives an event object and returns a response.
 * The Express server (src/server/) wraps these into Express routes.
 */

/* ------------------------------------------------------------------ */
/*  Request (Event)                                                    */
/* ------------------------------------------------------------------ */

export interface HandlerEvent {
  /** Full request URL */
  rawUrl: string;
  /** Raw query string (without leading ?) */
  rawQuery: string;
  /** Request path */
  path: string;
  /** HTTP method (GET, POST, etc.) */
  httpMethod: string;
  /** Request headers (lowercased keys) */
  headers: Record<string, string>;
  /** Multi-value headers */
  multiValueHeaders: Record<string, string[]>;
  /** Query string parameters */
  queryStringParameters: Record<string, string>;
  /** Multi-value query parameters */
  multiValueQueryStringParameters: Record<string, string[]>;
  /** Request body (string or null) */
  body: string | null;
  /** Whether body is base64 encoded */
  isBase64Encoded: boolean;
}

/* ------------------------------------------------------------------ */
/*  Response                                                           */
/* ------------------------------------------------------------------ */

export interface HandlerResponse {
  statusCode: number;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, (string | number | boolean)[]>;
  body?: string;
  isBase64Encoded?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Handler                                                            */
/* ------------------------------------------------------------------ */

/**
 * API handler function signature.
 * Receives an event and returns a response (or void for background handlers).
 */
export type Handler = (
  event: HandlerEvent,
  context?: Record<string, unknown>,
) => Promise<HandlerResponse | void>;
