// src/ingestion/dropbox.ts
/**
 * Dropbox Adapter
 * 
 * Handles file ingestion from Dropbox folders.
 * Refactored from smartdrafts-scan-core.ts to follow IngestionAdapter interface.
 */

import type { IngestionAdapter, IngestRequest, IngestedFile } from './types.js';
import { guessMime } from '../lib/mime.js';
import { copyToStaging, getStagedUrl } from '../lib/storage.js';
import { IngestError, IngestErrorCode } from './types.js';

interface DropboxEntry {
  '.tag': 'file' | 'folder';
  name: string;
  path_lower?: string;
  path_display?: string;
  id: string;
  client_modified?: string;
  server_modified?: string;
  size?: number;
}

/**
 * Check if filename is an image
 */
function isImage(name: string): boolean {
  const lower = name.toLowerCase();
  return /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(lower);
}

/**
 * Get Dropbox access token from refresh token
 */
async function dropboxAccessToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string
): Promise<string> {
  const cid = clientId || process.env.DROPBOX_CLIENT_ID || '';
  const cs = clientSecret || process.env.DROPBOX_CLIENT_SECRET || '';
  
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cid,
    client_secret: cs,
  });
  
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token) {
    throw new IngestError(
      IngestErrorCode.AUTH_FAILED,
      `Dropbox token refresh failed: ${res.status}`
    );
  }
  
  return String(json.access_token);
}

/**
 * Call Dropbox API
 */
async function dropboxApi(token: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`dropbox ${res.status}`);
    return {};
  }
  
  try {
    const json = JSON.parse(text);
    if (!res.ok) throw new Error(`dropbox ${res.status}: ${text}`);
    return json;
  } catch {
    if (!res.ok) throw new Error(`dropbox ${res.status}: ${text}`);
    return {};
  }
}

/**
 * List folder recursively
 */
async function listFolder(token: string, path: string): Promise<DropboxEntry[]> {
  let entries: DropboxEntry[] = [];
  
  let resp: any = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/list_folder', {
    include_deleted: false,
    include_media_info: true,
    recursive: true,
    path,
  });
  
  entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  
  while (resp?.has_more) {
    resp = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/list_folder/continue', {
      cursor: resp.cursor,
    });
    entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  }
  
  return entries.filter((entry) => entry['.tag'] === 'file' && isImage(entry.name));
}

/**
 * Create temporary link for Dropbox file
 */
async function createTemporaryLink(token: string, path: string): Promise<string> {
  const resp = await dropboxApi(token, 'https://api.dropboxapi.com/2/files/get_temporary_link', {
    path,
  });
  
  return resp?.link || '';
}

/**
 * Ensure file is copied to staging storage
 * Returns staging key
 */
async function ensureStagedCopy(
  entry: DropboxEntry,
  tempLink: string,
  userId: string,
  jobId?: string
): Promise<string> {
  const mime = guessMime(entry.name);
  
  try {
    const key = await copyToStaging(tempLink, userId, entry.name, mime, jobId);
    return key;
  } catch (error: any) {
    throw new IngestError(
      IngestErrorCode.STAGING_FAILED,
      `Failed to stage ${entry.name}: ${error.message}`
    );
  }
}

/**
 * Dropbox Adapter Implementation
 */
export const DropboxAdapter: IngestionAdapter = {
  /**
   * List files from Dropbox folder and stage them
   * req.payload: { folderPath: string, refreshToken: string, cursor?: string, skipStaging?: boolean }
   */
  async list(req: IngestRequest): Promise<IngestedFile[]> {
    const folderPath = req.payload.folderPath as string | undefined;
    const refreshToken = req.payload.refreshToken as string | undefined;
    const skipStaging = req.payload.skipStaging as boolean | undefined;
    const jobId = req.payload.jobId as string | undefined;
    
    if (!folderPath) {
      throw new IngestError(
        IngestErrorCode.INVALID_SOURCE,
        'folderPath required in payload'
      );
    }
    
    if (!refreshToken) {
      throw new IngestError(
        IngestErrorCode.AUTH_FAILED,
        'Dropbox refresh token required'
      );
    }
    
    // Get access token
    const accessToken = await dropboxAccessToken(refreshToken);
    
    // List folder
    const entries = await listFolder(accessToken, folderPath);
    
    if (entries.length === 0) {
      return [];
    }
    
    // Process entries
    const files: IngestedFile[] = [];
    
    for (const entry of entries) {
      try {
        // Create temporary link
        const tempLink = await createTemporaryLink(accessToken, entry.path_display || entry.path_lower || '');
        
        let stagedUrl: string;
        let stagingKey: string | undefined;
        
        if (skipStaging) {
          // Use Dropbox link directly (not recommended for production)
          stagedUrl = tempLink;
        } else {
          // Copy to staging storage
          stagingKey = await ensureStagedCopy(entry, tempLink, req.userId, jobId);
          stagedUrl = await getStagedUrl(stagingKey);
        }
        
        files.push({
          id: entry.id,
          name: entry.name,
          mime: guessMime(entry.name),
          bytes: entry.size,
          stagedUrl,
          meta: {
            sourcePath: entry.path_display || entry.path_lower,
            sourceId: entry.id,
            sourceCreatedAt: entry.client_modified || entry.server_modified,
            dropboxPath: entry.path_lower,
            stagingKey,
          },
        });
      } catch (error: any) {
        console.error(`[DropboxAdapter] Failed to process ${entry.name}:`, error);
        // Continue processing other files
      }
    }
    
    return files;
  },
};

/**
 * Validate Dropbox list payload
 */
export function validateDropboxListPayload(payload: any): {
  folderPath: string;
  refreshToken: string;
  cursor?: string;
  skipStaging?: boolean;
} {
  if (!payload || typeof payload !== 'object') {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'Invalid payload for Dropbox adapter'
    );
  }
  
  const folderPath = payload.folderPath;
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'folderPath must be a non-empty string'
    );
  }
  
  const refreshToken = payload.refreshToken;
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    throw new IngestError(
      IngestErrorCode.AUTH_FAILED,
      'refreshToken required for Dropbox access'
    );
  }
  
  return {
    folderPath: folderPath.trim(),
    refreshToken: refreshToken.trim(),
    cursor: payload.cursor,
    skipStaging: payload.skipStaging,
  };
}
