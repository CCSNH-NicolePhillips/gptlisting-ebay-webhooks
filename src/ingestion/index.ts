// src/ingestion/index.ts
/**
 * Ingestion Adapter Registry
 * 
 * Central resolver for all file source adapters.
 * Supports: local, dropbox, gdrive, s3, icloud
 */

import type { IngestionAdapter, SourceType, IngestRequest, IngestedFile, PresignedUpload } from './types.js';
import { IngestError, IngestErrorCode } from './types.js';
import { LocalAdapter } from './local.js';
import { DropboxAdapter } from './dropbox.js';

/**
 * Adapter registry
 */
const adapters: Partial<Record<SourceType, IngestionAdapter>> = {
  local: LocalAdapter,
  dropbox: DropboxAdapter,
  // TODO: Add more adapters
  // gdrive: GoogleDriveAdapter,
  // s3: S3Adapter,
  // icloud: iCloudAdapter,
};

/**
 * Get adapter for source type
 * Throws if source is not supported
 */
export function getAdapter(source: SourceType): IngestionAdapter {
  const adapter = adapters[source];
  
  if (!adapter) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      `Source not supported: ${source}. Supported: ${Object.keys(adapters).join(', ')}`
    );
  }
  
  return adapter;
}

/**
 * List supported sources
 */
export function getSupportedSources(): SourceType[] {
  return Object.keys(adapters) as SourceType[];
}

/**
 * Check if source is supported
 */
export function isSourceSupported(source: string): source is SourceType {
  return source in adapters;
}

/**
 * Ingest files from any source
 * High-level convenience function
 */
export async function ingestFiles(req: IngestRequest): Promise<IngestedFile[]> {
  const adapter = getAdapter(req.source);
  return await adapter.list(req);
}

/**
 * Stage files for upload (local only)
 */
export async function stageUpload(req: IngestRequest): Promise<{ uploads: PresignedUpload[] }> {
  const adapter = getAdapter(req.source);
  
  if (!adapter.stage) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      `Source ${req.source} does not support staging`
    );
  }
  
  return await adapter.stage(req);
}

/**
 * Validate source and payload before ingestion
 */
export function validateIngestRequest(source: string, payload: any): void {
  if (!isSourceSupported(source)) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      `Invalid source: ${source}`
    );
  }
  
  if (!payload || typeof payload !== 'object') {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'Payload must be an object'
    );
  }
}

// Re-export types and adapters
export * from './types.js';
export { LocalAdapter } from './local.js';
export { DropboxAdapter } from './dropbox.js';
