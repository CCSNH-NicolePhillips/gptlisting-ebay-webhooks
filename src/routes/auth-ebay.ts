import express from 'express';
import { buildEbayAuthUrl, exchangeAuthCode, saveEbayTokens, whoAmI } from '../services/ebay.js';

export const ebayAuthRouter = express.Router();

ebayAuthRouter.get('/auth/ebay', (req, res) => {
  res.redirect(buildEbayAuthUrl());
});

// ebayAuthRouter.get('/auth/ebay/callback', async (req, res) => {
//   const code = req.query.code as string;
//   if (!code) return res.status(400).send('Missing code');
//   const tok = await exchangeAuthCode(code);
//   await saveEbayTokens('demo', tok);
//   const me = await whoAmI('demo');
//   res.send(`eBay connected for demo. Hello ${me?.userId || 'unknown'}`);
// });

ebayAuthRouter.get('/auth/ebay/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing code');
  const tok = await exchangeAuthCode(code);
  await saveEbayTokens('demo', tok);
  res.redirect('/connected/ebay'); // <— this line does the magic
});
