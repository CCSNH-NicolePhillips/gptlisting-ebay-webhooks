/**
 * DEPRECATED: Legacy Express route - NOT USED
 * All functionality has been migrated to Netlify Functions.
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Since migration to Netlify Functions
 * @see netlify/functions/ebay-oauth-* for current implementation
 */

// import express from 'express';
// import { buildEbayAuthUrl, exchangeAuthCode, saveEbayTokens } from '../services/ebay.js';

// export const ebayAuthRouter = express.Router();

// ebayAuthRouter.get('/auth/ebay', (req, res) => {
//   res.redirect(buildEbayAuthUrl());
// });

// ebayAuthRouter.get('/auth/ebay/callback', async (req, res) => {
//   const code = req.query.code as string;
//   if (!code) return res.status(400).send('Missing code');
//   try {
//     const tok = await exchangeAuthCode(code);
//     await saveEbayTokens('demo', tok);
//     res.redirect('/connected/ebay');
//   } catch (err) {
//     const detail = err instanceof Error ? err.message : String(err);
//     console.error('[ebayAuthRouter] callback error:', detail);
//     res.status(500).send(`eBay callback error: ${detail}`);
//   }
// });

export const ebayAuthRouter = {};
