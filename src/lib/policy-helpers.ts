/**
 * Policy helpers for detecting policy features
 */

/**
 * Detects if a fulfillment policy offers free domestic shipping
 * 
 * @param policy - The fulfillment policy object from eBay API
 * @returns true if the policy has free domestic shipping
 */
export function hasFreeShipping(policy: any): boolean {
	if (!policy || typeof policy !== 'object') return false;

	const shippingOptions = policy.shippingOptions;
	if (!Array.isArray(shippingOptions) || shippingOptions.length === 0) return false;

	// Check domestic shipping options
	for (const option of shippingOptions) {
		if (option.optionType !== 'DOMESTIC') continue;

		const services = option.shippingServices;
		if (!Array.isArray(services)) continue;

		// If ANY service has freeShipping: true, consider it free shipping
		for (const service of services) {
			if (service.freeShipping === true) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Extracts the shipping cost from a fulfillment policy (for non-free policies)
 * 
 * @param policy - The fulfillment policy object from eBay API
 * @returns Shipping cost in cents, or null if free or calculated
 */
export function extractShippingCost(policy: any): number | null {
	if (!policy || typeof policy !== 'object') return null;

	const shippingOptions = policy.shippingOptions;
	if (!Array.isArray(shippingOptions) || shippingOptions.length === 0) return null;

	// Look for domestic flat rate shipping
	for (const option of shippingOptions) {
		if (option.optionType !== 'DOMESTIC') continue;
		if (option.costType !== 'FLAT_RATE') continue;

		const services = option.shippingServices;
		if (!Array.isArray(services) || services.length === 0) continue;

		// Use the first service's cost
		const service = services[0];
		if (service.freeShipping === true) return 0;

		const cost = service.shippingCost;
		if (cost && typeof cost.value === 'string') {
			const dollars = parseFloat(cost.value);
			if (!isNaN(dollars) && dollars >= 0) {
				return Math.round(dollars * 100); // Convert to cents
			}
		}
	}

	// For calculated shipping, we can't determine the cost
	return null;
}
