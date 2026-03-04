/**
 * packages/core/src/services/pricing/reduction-update.ts
 *
 * Update auto price-reduction configuration for a listing binding.
 */

import {
  getListingBinding,
  updateBinding,
  type ListingBinding,
  type AutoConfig,
} from '../../../../../src/lib/price-store.js';

export type { AutoConfig, ListingBinding };

export class BindingNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(jobId: string, groupId: string) {
    super(`Binding ${jobId}/${groupId} not found`);
    this.name = 'BindingNotFoundError';
  }
}

export class UnauthorizedBindingError extends Error {
  readonly statusCode = 403;
  constructor() {
    super('Not authorized to update this binding');
    this.name = 'UnauthorizedBindingError';
  }
}

export class InvalidReductionParamsError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReductionParamsError';
  }
}

/**
 * Validate and persist a price-reduction auto configuration.
 *
 * @param userId  Authenticated user — must own the binding.
 * @param jobId   Job ID of the binding.
 * @param groupId Group ID of the binding.
 * @param auto    New auto config, or `null` to disable.
 */
export async function updatePriceReduction(
  userId: string,
  jobId: string,
  groupId: string,
  auto: AutoConfig | null,
): Promise<ListingBinding> {
  const existing = await getListingBinding(jobId, groupId);
  if (!existing) throw new BindingNotFoundError(jobId, groupId);
  if (existing.userId !== userId) throw new UnauthorizedBindingError();

  if (auto !== null) {
    const { reduceBy, everyDays, minPrice } = auto;
    if (typeof reduceBy !== 'number' || reduceBy <= 0 || reduceBy > 100) {
      throw new InvalidReductionParamsError('reduceBy must be between 0.01 and 100');
    }
    if (typeof everyDays !== 'number' || everyDays < 1 || everyDays > 90) {
      throw new InvalidReductionParamsError('everyDays must be between 1 and 90');
    }
    if (typeof minPrice !== 'number' || minPrice < 0) {
      throw new InvalidReductionParamsError('minPrice must be >= 0');
    }
    if (minPrice >= (existing.currentPrice ?? Infinity)) {
      throw new InvalidReductionParamsError(
        `minPrice ($${minPrice.toFixed(2)}) must be less than current price ($${(existing.currentPrice ?? 0).toFixed(2)})`,
      );
    }
  }

  const updated = await updateBinding(jobId, groupId, { auto });
  if (!updated) throw new Error('Failed to update binding');
  return updated;
}
