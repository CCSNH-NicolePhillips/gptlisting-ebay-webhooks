import express from 'express';
import { router } from './routes/index.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use('/api', router);

const PORT = Number(process.env.PORT) || 3000;

// Only start listening when this file is run directly (not when imported by tests).
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[api] listening on :${PORT}`);
  });
}

export { app };

