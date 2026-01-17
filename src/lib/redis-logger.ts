/**
 * Redis-based logging for pipeline debugging.
 * Stores logs per job with automatic TTL expiration.
 * 
 * Usage:
 *   const logger = createJobLogger(jobId);
 *   logger.info('Processing product', { productId: 'abc123' });
 *   logger.debug('Pricing result', { price: 22.00 });
 *   logger.error('Failed to fetch', { error: err.message });
 */

import { redisCall } from './job-store.js';

export interface LogEntry {
  ts: number;      // timestamp
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;     // message
  data?: unknown;  // optional structured data
}

export interface JobLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  flush(): Promise<void>;
}

// TTL for logs - 48 hours
const LOG_TTL_SECONDS = 48 * 60 * 60;

// Buffer logs in memory and flush periodically to reduce Redis calls
const LOG_BUFFER_SIZE = 20;
const LOG_FLUSH_INTERVAL_MS = 5000;

/**
 * Create a logger that stores logs in Redis for a specific job.
 * Logs are buffered and flushed periodically or when buffer is full.
 */
export function createJobLogger(jobId: string, options?: { prefix?: string }): JobLogger {
  const prefix = options?.prefix || '';
  const buffer: LogEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  const key = `logs:${jobId}`;

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0 || flushing) return;
    
    flushing = true;
    const toFlush = buffer.splice(0, buffer.length);
    
    try {
      // Get existing logs
      const existing = await redisCall('GET', key);
      let logs: LogEntry[] = [];
      
      if (existing.result && typeof existing.result === 'string') {
        try {
          logs = JSON.parse(existing.result);
        } catch {
          logs = [];
        }
      }
      
      // Append new logs
      logs.push(...toFlush);
      
      // Limit total logs to prevent unbounded growth (keep last 500)
      if (logs.length > 500) {
        logs = logs.slice(-500);
      }
      
      // Store with TTL
      await redisCall('SET', key, JSON.stringify(logs), 'EX', LOG_TTL_SECONDS.toString());
    } catch (err) {
      // On error, put logs back in buffer (best effort)
      console.error('[redis-logger] Failed to flush logs:', err);
      buffer.unshift(...toFlush);
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flushBuffer();
    }, LOG_FLUSH_INTERVAL_MS);
  }

  function log(level: LogEntry['level'], msg: string, data?: unknown): void {
    const fullMsg = prefix ? `[${prefix}] ${msg}` : msg;
    
    buffer.push({
      ts: Date.now(),
      level,
      msg: fullMsg,
      data: data !== undefined ? sanitizeData(data) : undefined,
    });

    // Also log to console for Railway logs
    const consoleMsg = `[${level.toUpperCase()}] ${fullMsg}`;
    if (data !== undefined) {
      console[level === 'debug' ? 'log' : level](consoleMsg, data);
    } else {
      console[level === 'debug' ? 'log' : level](consoleMsg);
    }

    // Flush if buffer is full, otherwise schedule
    if (buffer.length >= LOG_BUFFER_SIZE) {
      flushBuffer().catch(() => {});
    } else {
      scheduleFlush();
    }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
    flush: async () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flushBuffer();
    },
  };
}

/**
 * Retrieve logs for a job.
 */
export async function getJobLogs(jobId: string): Promise<LogEntry[]> {
  const key = `logs:${jobId}`;
  const result = await redisCall('GET', key);
  
  if (!result.result || typeof result.result !== 'string') {
    return [];
  }
  
  try {
    return JSON.parse(result.result);
  } catch {
    return [];
  }
}

/**
 * Delete logs for a job (manual cleanup if needed).
 */
export async function deleteJobLogs(jobId: string): Promise<void> {
  const key = `logs:${jobId}`;
  await redisCall('DEL', key);
}

/**
 * Sanitize data for JSON serialization.
 * Handles errors, circular refs, and large objects.
 */
function sanitizeData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  
  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack?.split('\n').slice(0, 5).join('\n'),
    };
  }
  
  if (typeof data !== 'object') return data;
  
  try {
    // Test if serializable and not too large
    const json = JSON.stringify(data);
    if (json.length > 10000) {
      // Truncate large objects
      return JSON.parse(json.slice(0, 10000) + '...(truncated)');
    }
    return data;
  } catch {
    // Not serializable (circular ref, etc)
    return String(data);
  }
}
