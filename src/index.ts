import express from 'express';
import { cfg } from './config.js';
import { dropboxAuthRouter } from './routes/auth-dropbox.js';
import { ebayAuthRouter } from './routes/auth-ebay.js';
import { processRouter } from './routes/process.js';
import { whoAmI, listPolicies, listInventoryLocations } from './services/ebay.js';
import { setupRouter } from './routes/setup.js';
import offersRouter from './routes/offers.js';
import adminRouter from './routes/admin.js';


const app = express();
app.use(express.json({ limit: '10mb' }));

app.use(setupRouter);

// demo in-memory user store
const store:any = {
  users: { demo: { id: 'demo', name: 'Demo User' } },
  accounts: {} // per-user: { dropbox: {...}, ebay: {...} }
};
app.set('store', store);

// health
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/connected/ebay', (_req, res) => {
  res.send('<h2>eBay connected successfully!</h2><p>You can close this window.</p>');
});


app.get('/me/ebay', async (_req, res) => {
  try { res.json(await whoAmI('demo')); }
  catch (e:any) { res.status(500).json({ error: e.message }); }
});

app.get('/me/ebay/policies', async (_req, res) => {
  try { res.json(await listPolicies('demo')); }
  catch (e:any) { res.status(500).json({ error: e.message }); }
});

app.get('/me/ebay/locations', async (_req, res) => {
  try { res.json(await listInventoryLocations('demo')); }
  catch (e:any) { res.status(500).json({ error: e.message }); }
});


// auth routes
app.use(dropboxAuthRouter);
app.use(ebayAuthRouter);

// process endpoint
app.use(processRouter);
app.use(offersRouter);
app.use(adminRouter);

// start
app.listen(cfg.port, () => {
  console.log(`Server running on :${cfg.port}`);
});
