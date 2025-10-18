import express from 'express';
import { cfg } from '../config.js';
import fs from 'fs';
import path from 'path';

export const adminRouter = express.Router();

function mapPath() { return path.join(cfg.dataDir, 'category_map.json'); }

adminRouter.get('/admin/category-map', (_req, res) => {
  try {
    const p = mapPath();
    if (!fs.existsSync(p)) return res.json({});
    const j = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    res.json(j);
  } catch (e:any) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/admin/category-map', (req, res) => {
  try {
    const p = mapPath();
    const current = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8') || '{}') : {};
    const updates = req.body || {};
    const merged = { ...current, ...updates };
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(merged, null, 2));
    res.json(merged);
  } catch (e:any) { res.status(500).json({ error: e.message }); }
});

export default adminRouter;
