import type { Handler } from '@netlify/functions';
import sharp from 'sharp';

// Netlify Functions have a 6MB response limit, base64 encoding adds ~33% overhead
// So we target ~4MB max image size to be safe
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
const MAX_DIMENSION = 2000; // Max width/height for eBay images

export const handler: Handler = async (event) => {
	try {
		const src = event.queryStringParameters?.url;
		if (!src) return { statusCode: 400, body: 'Missing ?url' };

		const u = new URL(src);
		if (u.protocol !== 'https:') return { statusCode: 400, body: 'Only https URLs are allowed' };

		// Normalize Dropbox viewer links to direct content host
		const normalizeDropbox = (input: string) => {
			try {
				const url = new URL(input);
				if (/\.dropbox\.com$/i.test(url.hostname)) {
					url.hostname = 'dl.dropboxusercontent.com';
					url.searchParams.delete('dl');
					url.searchParams.set('raw', '1');
				}
				return url.toString();
			} catch {
				return input
					.replace('www.dropbox.com', 'dl.dropboxusercontent.com')
					.replace('?dl=0', '?raw=1')
					.replace('&dl=0', '&raw=1');
			}
		};

		const tryFetch = async (url: string) => {
			const resp = await fetch(url, { redirect: 'follow' });
			const type = (resp.headers.get('content-type') || '').toLowerCase();
			return { resp, type };
		};

		let target = src;
		// First attempt
		let { resp, type } = await tryFetch(target);
		// If Dropbox returns HTML viewer, try normalized direct link
		if (resp.ok && !type.startsWith('image/') && /dropbox\.com/i.test(target)) {
			target = normalizeDropbox(target);
			({ resp, type } = await tryFetch(target));
		}
		if (!resp.ok) return { statusCode: resp.status, body: `Upstream fetch failed: ${resp.status}` };
		const buf = Buffer.from(await resp.arrayBuffer());
		if (!type.startsWith('image/')) {
			return { statusCode: 415, body: `Not an image (type=${type})` };
		}
		
		// Process image: auto-orient, resize if too large, compress if needed
		let outBuf: Buffer = buf as Buffer;
		try {
			const s = sharp(buf, { failOnError: false });
			const metadata = await s.metadata();
			
			const needsRotation = metadata.orientation && metadata.orientation !== 1;
			const needsResize = (metadata.width && metadata.width > MAX_DIMENSION) || 
			                    (metadata.height && metadata.height > MAX_DIMENSION);
			const isTooLarge = buf.length > MAX_IMAGE_BYTES;
			
			if (needsRotation || needsResize || isTooLarge) {
				// Build sharp pipeline
				let pipeline = sharp(buf, { failOnError: false });
				
				// Auto-rotate based on EXIF
				if (needsRotation) {
					pipeline = pipeline.rotate();
				}
				
				// Resize if dimensions too large
				if (needsResize) {
					pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
						fit: 'inside',
						withoutEnlargement: true
					});
				}
				
				// Choose quality based on size - aim for <4MB output
				// Start with high quality, reduce if image is very large
				let quality = 90;
				if (buf.length > 8 * 1024 * 1024) quality = 75; // >8MB original
				else if (buf.length > 6 * 1024 * 1024) quality = 80; // >6MB original
				else if (buf.length > 4 * 1024 * 1024) quality = 85; // >4MB original
				
				outBuf = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
				
				// If still too large, compress more aggressively
				if (outBuf.length > MAX_IMAGE_BYTES) {
					outBuf = await sharp(buf, { failOnError: false })
						.rotate()
						.resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
						.jpeg({ quality: 70, mozjpeg: true })
						.toBuffer();
				}
			}
		} catch (sharpErr) {
			// If sharp fails, try to at least return something
			console.error('[image-proxy] sharp error:', sharpErr);
		}
		
		// Final size check - if still too large, we can't serve it
		if (outBuf.length > MAX_IMAGE_BYTES) {
			return { 
				statusCode: 413, 
				body: `Image too large after compression (${Math.round(outBuf.length/1024/1024)}MB). Max is ${MAX_IMAGE_BYTES/1024/1024}MB.` 
			};
		}

		// Return JPEG so downstream (eBay) gets normalized pixels without EXIF orientation
		return {
			statusCode: 200,
			headers: {
				'Content-Type': 'image/jpeg',
				'Cache-Control': 'public, max-age=31536000, immutable',
				// Allow eBay crawler
				'Access-Control-Allow-Origin': '*',
			},
			body: outBuf.toString('base64'),
			isBase64Encoded: true,
		};
	} catch (e: any) {
		return { statusCode: 502, body: `image-proxy error: ${e?.message || String(e)}` };
	}
};
