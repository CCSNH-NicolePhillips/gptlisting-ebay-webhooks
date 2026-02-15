import type { Handler } from '../../src/types/api-handler.js';
import { tokenHosts, appAccessToken } from '../../src/lib/_common.js';
import { cacheStore } from '../../src/lib/redis-store.js';

export const handler: Handler = async (event) => {
	try {
		const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
		const { apiHost } = tokenHosts(process.env.EBAY_ENV);
		const store = cacheStore();
		const cacheKey = `taxonomy-tree-${MARKETPLACE_ID}.json`;
		const qs = event.queryStringParameters || {};
		const refresh = qs.refresh === '1' || qs.refresh === 'true';

		let cached = !refresh ? ((await store.get(cacheKey, { type: 'json' })) as any) : undefined;
		if (!cached) {
			const { access_token } = await appAccessToken([
				'https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly',
			]);
			const headers = {
				Authorization: `Bearer ${access_token}`,
				Accept: 'application/json',
				'Accept-Language': 'en-US',
				'Content-Language': 'en-US',
				'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
			} as Record<string, string>;
			// Get default tree ID
			const tRes = await fetch(
				`${apiHost}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`,
				{ headers }
			);
			const tJson = await tRes.json();
			const treeId = tJson?.categoryTreeId;
			if (!treeId)
				return { statusCode: 500, body: JSON.stringify({ error: 'no tree id', detail: tJson }) };

			// Stream categories: get descendants of ROOT
			const res = await fetch(`${apiHost}/commerce/taxonomy/v1/category_tree/${treeId}`, {
				headers,
			});
			const full = await res.json();

			function flatten(node: any, path: string[] = []): any[] {
				if (!node) return [];
				const name =
					node.categoryTreeNode?.category?.categoryName ||
					node.category?.categoryName ||
					node.categoryName;
				const id =
					node.categoryTreeNode?.category?.categoryId ||
					node.category?.categoryId ||
					node.categoryId;
				const children = node.children || node.childCategoryTreeNodes || [];
				const here =
					id && name
						? [{ categoryId: id, categoryName: name, categoryPath: [...path, name].join(' > ') }]
						: [];
				const nextPath = name ? [...path, name] : path;
				const kids = children.flatMap((c: any) => flatten(c, nextPath));
				return [...here, ...kids];
			}
			const flat = flatten(full);
			cached = { treeId, count: flat.length, categories: flat };
			await store.setJSON(cacheKey, cached);
		}

		// Optionally filter via q query
		const q = (event.queryStringParameters?.q || '').trim().toLowerCase();
		let list = cached.categories as any[];
		if (q)
			list = list.filter(
				(c) =>
					(c.categoryName || '').toLowerCase().includes(q) ||
					(c.categoryPath || '').toLowerCase().includes(q)
			);

		// Limit results for UI performance
		const limit = Number(event.queryStringParameters?.limit || 200);
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ok: true,
				treeId: cached.treeId,
				count: cached.count,
				results: list.slice(0, limit),
			}),
		};
	} catch (e: any) {
		return {
			statusCode: 500,
			body: JSON.stringify({ error: 'category-tree error', detail: e?.message || String(e) }),
		};
	}
};