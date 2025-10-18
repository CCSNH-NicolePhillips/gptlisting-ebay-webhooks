import express from 'express';
import { cfg } from '../config.js';
import { getAccessToken, createOffer, publishOffer, ensureInventoryItem } from '../services/ebay.js';

export const offersRouter = express.Router();

// Fetch full offer JSON from eBay
offersRouter.get('/me/ebay/offer/:offerId', async (req, res) => {
  try {
    const access = await getAccessToken('demo');
    // getAccessToken returns a token string in services; but here we reuse the service call
    // For simplicity, call the service's existing mechanisms via fetch in scripts;
    // We'll perform the call directly using fetch to include language headers.
    const token = access;
    const base = cfg.ebay.env === 'PROD' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
    const r = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(req.params.offerId)}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Language': 'en-US', 'Content-Language': 'en-US' } });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); } catch { res.status(r.status).send(text); }
  } catch (e:any) { res.status(500).json({ error: e?.message || String(e) }); }
});

// Update inventory item (sku) — title/description/condition/quantity/imageUrls
offersRouter.put('/me/ebay/inventory/:sku', async (req, res) => {
  try {
    const sku = req.params.sku;
    const body = req.body;
    // body: { title, description, condition, quantity, imageUrls }
    await ensureInventoryItem('demo', sku, {
      title: body.title || `Listing ${sku}`,
      description: body.description || '',
      condition: body.condition || 'NEW',
      quantity: body.quantity || 1,
      imageUrls: body.imageUrls || []
    });
    res.json({ ok: true });
  } catch (e:any) { res.status(400).json({ error: e?.message || String(e) }); }
});

// Update offer (partial update): price, availableQuantity, listingPolicies
offersRouter.put('/me/ebay/offer/:offerId', async (req, res) => {
  try {
    const offerId = req.params.offerId;
    const body = req.body; // expected price, availableQuantity, listingPolicies
    const token = await getAccessToken('demo');
    const base = cfg.ebay.env === 'PROD' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
    // Fetch existing offer
    const getR = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'en-US', 'Content-Language': 'en-US' } });
    const getText = await getR.text();
    const offer = JSON.parse(getText);
    // Apply updates
    if (body.price) offer.pricingSummary = { price: { currency: body.currency || 'USD', value: String(body.price) } };
    if (body.availableQuantity) offer.availableQuantity = body.availableQuantity;
    if (body.listingPolicies) offer.listingPolicies = { ...offer.listingPolicies, ...body.listingPolicies };

    const putR = await fetch(`${base}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Language': 'en-US', 'Content-Language': 'en-US' }, body: JSON.stringify(offer) });
    const putText = await putR.text();
    try { res.status(putR.status).json(JSON.parse(putText)); } catch { res.status(putR.status).send(putText); }
  } catch (e:any) { res.status(500).json({ error: e?.message || String(e) }); }
});

// Publish offer
offersRouter.post('/me/ebay/offer/:offerId/publish', async (req, res) => {
  try {
    const result = await publishOffer('demo', req.params.offerId);
    res.json({ ok: true, result });
  } catch (e:any) { res.status(400).json({ error: e?.message || String(e) }); }
});

export default offersRouter;
