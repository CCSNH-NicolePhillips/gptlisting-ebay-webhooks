/**
 * settings.ts — GET /api/settings, POST /api/settings
 *
 * User-specific settings: promotion prefs, pricing config, auto-price reduction,
 * best offer.  Backed by Upstash Redis (same store as the Netlify originals).
 *
 * Same JSON contract as:
 *   /.netlify/functions/user-settings-get  (GET)
 *   /.netlify/functions/user-settings-save (POST)
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  getUserSettings,
  saveUserSettings,
  validateSaveInput,
  type SaveSettingsInput,
} from '../../../../src/services/user-settings.service.js';
import { serverError } from '../http/respond.js';

const router = Router();

/**
 * GET /api/settings
 *
 * Same JSON contract as /.netlify/functions/user-settings-get.
 */
router.get('/', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const settings = await getUserSettings(userId);
    return res.status(200).json(settings);
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

/**
 * POST /api/settings
 *
 * Same JSON contract as /.netlify/functions/user-settings-save.
 * Body: { autoPromoteEnabled?, defaultPromotionRate?, pricing?, autoPrice?, bestOffer?, showPricingLogs? }
 * Returns: { ok: true, settings }
 */
router.post('/', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);

    const input = req.body as SaveSettingsInput;
    const validationError = validateSaveInput(input);
    if (validationError) {
      return res.status(400).json(validationError);
    }

    const settings = await saveUserSettings(userId, input);
    return res.status(200).json({ ok: true, settings });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

export default router;
