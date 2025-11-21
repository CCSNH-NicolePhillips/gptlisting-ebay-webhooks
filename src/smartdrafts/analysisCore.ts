/**
 * Shared SmartDrafts Analysis Core
 * 
 * This module provides the core analysis functionality for SmartDrafts,
 * extracting it from the Netlify function layer to enable reuse across
 * different endpoints (standard analysis, pairing labs, etc).
 * 
 * Phase 2: Hook pairing-labs-run into the analysis pipeline
 */

import { runSmartDraftScan, type SmartDraftScanOptions, type SmartDraftScanBody } from "../lib/smartdrafts-scan-core.js";

export interface AnalysisOverrides {
  forceRescan?: boolean;
  // Keep minimal for now - can expand later
}

export interface AnalysisResult {
  folder: string;
  jobId: string;
  cached: boolean;
  imageCount: number;
  groups: any[];
  // Include everything pairing might need
  imageInsights?: Record<string, any>;
  warnings?: string[];
  signature?: string | null;
}

/**
 * Run SmartDrafts analysis on a Dropbox folder or staged URLs
 * 
 * This is the shared core that both the existing smartdrafts-scan endpoint
 * and the new pairing-labs endpoint use.
 * 
 * @param folder - Dropbox folder path (e.g., "/newStuff")
 * @param overrides - Optional overrides for force rescan, etc.
 * @param userId - User ID for quota tracking and auth
 * @param stagedUrls - Optional pre-staged URLs (alternative to folder)
 * @param skipQuota - Skip quota checking (for internal/labs use)
 * @returns Analysis result with groups, insights, and metadata
 */
export async function runSmartdraftsAnalysis(
  folder: string,
  overrides: AnalysisOverrides = {},
  userId: string,
  stagedUrls?: string[],
  skipQuota: boolean = false
): Promise<AnalysisResult> {
  console.log('[analysisCore] runSmartdraftsAnalysis called', {
    folder,
    overrides,
    userId,
    stagedUrlsCount: stagedUrls?.length || 0,
    skipQuota
  });

  // Build options for the core scan function
  const scanOptions: SmartDraftScanOptions = {
    userId,
    folder: stagedUrls?.length ? undefined : folder,
    stagedUrls,
    force: overrides.forceRescan || false,
    skipQuota,
  };

  console.log('[analysisCore] Calling runSmartDraftScan with options:', scanOptions);

  // Call the existing scan core (this does all the heavy lifting)
  const scanResult = await runSmartDraftScan(scanOptions);

  console.log('[analysisCore] runSmartDraftScan returned:', {
    status: scanResult.status,
    ok: scanResult.body.ok,
    cached: scanResult.body.cached,
    groupCount: scanResult.body.groups?.length || 0,
    hasImageInsights: !!scanResult.body.imageInsights,
  });

  // Map the scan result to our standard AnalysisResult format
  const body: SmartDraftScanBody = scanResult.body;

  if (!body.ok) {
    throw new Error(body.error || 'Analysis failed');
  }

  const result: AnalysisResult = {
    folder: body.folder || folder,
    jobId: body.signature || 'no-signature',
    cached: body.cached || false,
    imageCount: body.count || body.groups?.length || 0,
    groups: body.groups || [],
    imageInsights: body.imageInsights,
    warnings: body.warnings,
    signature: body.signature,
  };

  console.log('[analysisCore] Returning AnalysisResult:', {
    folder: result.folder,
    jobId: result.jobId,
    cached: result.cached,
    imageCount: result.imageCount,
    groupCount: result.groups.length,
  });

  return result;
}
