/**
 * disconnect.service.ts — Remove stored OAuth tokens for a connected service.
 *
 * Supports:
 *   disconnectService(sub, 'ebay')    → deletes users/<sub>/ebay.json
 *   disconnectService(sub, 'dropbox') → deletes users/<sub>/dropbox.json
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';

export type DisconnectableService = 'ebay' | 'dropbox';

export interface DisconnectResult {
  ok: true;
  service: DisconnectableService;
  message: string;
}

/**
 * Remove the stored OAuth refresh token for the given service.
 *
 * @param sub     Auth0 sub of the authenticated user.
 * @param service 'ebay' or 'dropbox'.
 */
export async function disconnectService(
  sub: string,
  service: DisconnectableService,
): Promise<DisconnectResult> {
  const store = tokensStore();
  const key = service === 'ebay'
    ? userScopedKey(sub, 'ebay.json')
    : userScopedKey(sub, 'dropbox.json');

  await store.delete(key as any);

  return {
    ok: true,
    service,
    message: `${service} disconnected successfully`,
  };
}
