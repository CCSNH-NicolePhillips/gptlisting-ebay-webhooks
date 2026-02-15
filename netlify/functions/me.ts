import type { Handler } from '../../src/types/api-handler.js';
import { requireAuthVerified } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
	try {
		const verified = await requireAuthVerified(event);
		if (!verified) return json({ error: 'unauthorized' }, 401);
		const { sub, claims } = verified;
		return json({ ok: true, sub, email: claims?.email, name: claims?.name });
	} catch (e: any) {
		return json({ error: 'unauthorized', detail: e?.message || String(e) }, 401);
	}
};

function json(body: unknown, status = 200) {
	return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
