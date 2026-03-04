/**
 * packages/core/src/services/listings/bind.ts
 *
 * Platform-agnostic wrappers for listing-binding CRUD operations.
 * Delegates to the price-store Redis layer.
 */

import {
  bindListing as _bindListing,
  getListingBinding as _getListingBinding,
  getBindingsForJob as _getBindingsForJob,
  removeBinding as _removeBinding,
  type BindListingInput,
  type ListingBinding,
} from '../../../../../src/lib/price-store.js';

export type { BindListingInput, ListingBinding };

export async function bindListingEntry(input: BindListingInput): Promise<ListingBinding> {
  return _bindListing(input);
}

export async function getBinding(jobId: string, groupId: string): Promise<ListingBinding | null> {
  return _getListingBinding(jobId, groupId);
}

export async function getJobBindings(jobId: string): Promise<ListingBinding[]> {
  return _getBindingsForJob(jobId);
}

export async function deleteBinding(jobId: string, groupId: string): Promise<boolean> {
  return _removeBinding(jobId, groupId);
}
