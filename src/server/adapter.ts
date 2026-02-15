/**
 * API Handler → Express Adapter
 * 
 * Wraps API handlers to work as Express route handlers.
 */

import type { Request, Response } from 'express';
import type { Handler, HandlerEvent, HandlerResponse } from '../types/api-handler.js';

/**
 * Convert Express request to HandlerEvent
 */
function toEvent(req: Request): HandlerEvent {
  // Build headers record
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(', ');
    }
  }

  // Build query string parameters
  const queryStringParameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') {
      queryStringParameters[key] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      queryStringParameters[key] = value[0];
    }
  }

  // Build multi-value query string parameters
  const multiValueQueryStringParameters: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') {
      multiValueQueryStringParameters[key] = [value];
    } else if (Array.isArray(value)) {
      multiValueQueryStringParameters[key] = value.filter((v): v is string => typeof v === 'string');
    }
  }

  // Get raw body
  let body: string | null = null;
  let isBase64Encoded = false;
  
  if (req.body) {
    if (Buffer.isBuffer(req.body)) {
      body = req.body.toString('base64');
      isBase64Encoded = true;
    } else if (typeof req.body === 'string') {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
    }
  }

  return {
    rawUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    rawQuery: req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '',
    path: req.path,
    httpMethod: req.method,
    headers,
    multiValueHeaders: {},
    queryStringParameters,
    multiValueQueryStringParameters,
    body,
    isBase64Encoded,
  };
}

/**
 * Send handler response through Express
 */
function sendResponse(res: Response, handlerResponse: HandlerResponse): void {
  // Set status code
  res.status(handlerResponse.statusCode || 200);

  // Set headers
  if (handlerResponse.headers) {
    for (const [key, value] of Object.entries(handlerResponse.headers)) {
      if (value !== undefined) {
        res.setHeader(key, String(value));
      }
    }
  }

  // Set multi-value headers
  if (handlerResponse.multiValueHeaders) {
    for (const [key, values] of Object.entries(handlerResponse.multiValueHeaders)) {
      if (values) {
        res.setHeader(key, values.map(String));
      }
    }
  }

  // Send body
  if (handlerResponse.body) {
    if (handlerResponse.isBase64Encoded) {
      res.send(Buffer.from(handlerResponse.body, 'base64'));
    } else {
      res.send(handlerResponse.body);
    }
  } else {
    res.end();
  }
}

/**
 * Wrap an API handler as an Express route handler
 */
export function wrapHandler(handler: Handler): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const event = toEvent(req);
      
      const result = await handler(event);
      
      if (!result) {
        res.status(500).json({ error: 'Handler returned no response' });
        return;
      }

      sendResponse(res, result as HandlerResponse);
    } catch (error) {
      console.error('[adapter] Handler error:', error);
      res.status(500).json({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

/**
 * Background handler wrapper — responds 202 immediately, runs handler async
 */
export function wrapBackgroundHandler(handler: Handler): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    const event = toEvent(req);
    
    // Immediately respond with 202 Accepted
    res.status(202).json({ accepted: true, message: 'Background job started' });
    
    // Run handler in background (don't await)
    const result = handler(event);
    if (result && typeof result.catch === 'function') {
      result.catch((error: Error) => {
        console.error('[adapter] Background handler error:', error);
      });
    }
  };
}
