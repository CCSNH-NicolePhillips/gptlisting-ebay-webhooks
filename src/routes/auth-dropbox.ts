import express from 'express';
import { cfg } from '../config.js';
import { oauthStartUrl, storeDropboxTokens, listFolder } from '../services/dropbox.js';

export const dropboxAuthRouter = express.Router();

// Start OAuth
dropboxAuthRouter.get('/auth/dropbox', async (req, res) => {
  const url = oauthStartUrl();
  res.redirect(url);
});

// OAuth callback
dropboxAuthRouter.get('/auth/dropbox/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokens = await storeDropboxTokens('demo', code); // demo user
    return res.send(`Dropbox connected for user demo. Scopes: ${tokens.scope}`);
  } catch (err: any) {
    console.error('Dropbox token exchange failed:', err?.message || err);
    const body = err?.message || String(err);
    // Common Dropbox invalid_grant when code is expired or already used
    if (body.includes('invalid_grant') || body.toLowerCase().includes("code doesn't exist") || body.toLowerCase().includes('code')) {
      return res.status(400).send(
        `Token exchange failed: the authorization code is missing, expired, or already used. Please <a href="/auth/dropbox">restart the Dropbox connect flow</a>.`);
    }
    return res.status(500).send(`Token exchange failed: ${body}`);
  }
});

// Simple list preview
dropboxAuthRouter.get('/me/dropbox/list', async (req, res) => {
  try {
    const data = await listFolder('demo', '/EBAY');
    res.json(data);
  } catch (e:any) {
    res.status(500).json({ error: e.message });
  }
});
