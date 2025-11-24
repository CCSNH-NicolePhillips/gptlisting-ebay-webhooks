#!/usr/bin/env node

/**
 * Get eBay refresh token using admin authentication
 */

import https from 'https';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load prod.env
const envPath = join(__dirname, '..', 'prod.env');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const [key, ...valueParts] = trimmed.split('=');
  if (key && valueParts.length > 0) {
    env[key.trim()] = valueParts.join('=').trim();
  }
}

const ADMIN_TOKEN = env.ADMIN_API_TOKEN;
const userSub = process.argv[2] || 'google-oauth2|1087675999998494531403';

console.log('Fetching eBay token for:', userSub);

const url = `https://draftpilot.app/.netlify/functions/get-my-ebay-token?adminToken=${encodeURIComponent(ADMIN_TOKEN)}&userSub=${encodeURIComponent(userSub)}`;

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data);
  });
}).on('error', console.error);
