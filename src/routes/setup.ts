/**
 * DEPRECATED: Legacy Express route - NOT USED
 * All functionality has been migrated to Netlify Functions.
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Since migration to Netlify Functions
 * @see netlify/functions/ebay-ensure-* for current implementation
 */

// import express from 'express';
// import { ensureEbayPrereqs } from '../services/ebay.js';

// export const setupRouter = express.Router();

// // POST /setup/ebay/bootstrap
// setupRouter.post('/setup/ebay/bootstrap', async (req, res) => {
//   try {
//     const ids = await ensureEbayPrereqs('demo', req.body || {});
//     res.json({ ok: true, ...ids });
//   } catch (e: any) {
//     // Try to include nested response text if available for debugging
//     const detail = e?.message || (e?.response && JSON.stringify(e.response)) || String(e);
//     console.error('bootstrap error detail:', detail);
//     res.status(500).json({ ok: false, error: detail });
//   }
// });

export const setupRouter = {};
