/**
 * Netlify-to-Express Adapter
 * 
 * Wraps Netlify function handlers to work with Express routes.
 * Minimal changes required to existing handlers.
 */

import type { Request, Response } from 'express';
import type { Handler, HandlerEvent, HandlerContext, HandlerResponse } from '@netlify/functions';

/**
 * Convert Express request to Netlify HandlerEvent
 */
function toNetlifyEvent(req: Request): HandlerEvent {
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
 * Create a mock Netlify context
 */
function createContext(): HandlerContext {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: 'express-adapter',
    functionVersion: '1.0.0',
    invokedFunctionArn: '',
    memoryLimitInMB: '1024',
    awsRequestId: crypto.randomUUID(),
    logGroupName: '',
    logStreamName: '',
    getRemainingTimeInMillis: () => 300000, // 5 minutes
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

/**
 * Send Netlify response through Express
 */
function sendResponse(res: Response, netlifyResponse: HandlerResponse): void {
  // Set status code
  res.status(netlifyResponse.statusCode || 200);

  // Set headers
  if (netlifyResponse.headers) {
    for (const [key, value] of Object.entries(netlifyResponse.headers)) {
      if (value !== undefined) {
        res.setHeader(key, String(value));
      }
    }
  }

  // Set multi-value headers
  if (netlifyResponse.multiValueHeaders) {
    for (const [key, values] of Object.entries(netlifyResponse.multiValueHeaders)) {
      if (values) {
        res.setHeader(key, values.map(String));
      }
    }
  }

  // Send body
  if (netlifyResponse.body) {
    if (netlifyResponse.isBase64Encoded) {
      res.send(Buffer.from(netlifyResponse.body, 'base64'));
    } else {
      res.send(netlifyResponse.body);
    }
  } else {
    res.end();
  }
}

/**
 * Wrap a Netlify handler to work as an Express route handler
 */
export function wrapHandler(handler: Handler): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const event = toNetlifyEvent(req);
      const context = createContext();
      
      const result = await handler(event, context);
      
      if (!result) {
        res.status(500).json({ error: 'Handler returned no response' });
        return;
      }

      sendResponse(res, result);
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
 * Background handler wrapper - runs async without waiting
 * Used for long-running background jobs
 */
export function wrapBackgroundHandler(handler: Handler): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    const event = toNetlifyEvent(req);
    const context = createContext();
    
    // Immediately respond with 202 Accepted
    res.status(202).json({ accepted: true, message: 'Background job started' });
    
    // Run handler in background (don't await)
    const result = handler(event, context);
    if (result && typeof result.catch === 'function') {
      result.catch((error: Error) => {
        console.error('[adapter] Background handler error:', error);
      });
    }
  };
}
