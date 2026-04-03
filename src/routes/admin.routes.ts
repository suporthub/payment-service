import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.middleware';
import { fxRateService } from '../services/FxRateService';
import { fxRateOverrideSchema } from '../types/payment.types';
import { AppError } from '../utils/errors';
import { prismaRead, prismaWrite } from '../lib/prisma';
import { logger } from '../lib/logger';

const router = Router();

// All routes here require admin JWT
router.use(requireAdmin);

// ── FX Rate Overrides ─────────────────────────────────────────────────────────

/**
 * GET /api/admin/payments/fx-rates
 * List all active admin-set FX rate overrides
 */
router.get('/fx-rates', async (_req: Request, res: Response) => {
  const overrides = await fxRateService.listOverrides();
  res.json({ success: true, data: overrides });
});

/**
 * GET /api/admin/payments/fx-rates/:pair/effective
 * Get the current effective rate for a pair and which source it came from.
 * Useful for admin dashboard debugging.
 */
router.get('/fx-rates/:pair/effective', async (req: Request, res: Response) => {
  const pair = String(req.params['pair'] ?? '').toUpperCase();
  const [from, to] = pair.split('_');
  if (!from || !to) throw new AppError('VALIDATION_ERROR', 400, 'pair must be e.g. VND_USD');

  const result = await fxRateService.getRateWithSource(from, to);
  res.json({ success: true, data: result });
});

/**
 * PUT /api/admin/payments/fx-rates
 * Set or update an admin FX rate override.
 * Example body: { "pair": "VND_USD", "rate": 0.0000399, "reason": "Temporary adjustment" }
 *
 * Priority: DB override > Redis cache > Live API > Env fallback
 * Setting an override immediately writes to DB AND updates Redis cache.
 */
router.put('/fx-rates', async (req: Request, res: Response) => {
  const parsed = fxRateOverrideSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, parsed.error.errors[0]?.message ?? 'Validation failed');
  }

  await fxRateService.setOverride({
    ...parsed.data,
    adminId: req.user!.userId,
  });

  logger.info({ pair: parsed.data.pair, rate: parsed.data.rate, adminId: req.user!.userId }, 'Admin FX rate override set');
  res.json({
    success: true,
    message: `FX rate for ${parsed.data.pair} set to ${parsed.data.rate}`,
  });
});

/**
 * DELETE /api/admin/payments/fx-rates/:pair
 * Remove an admin override. Service reverts to live API rate.
 */
router.delete('/fx-rates/:pair', async (req: Request, res: Response) => {
  const pair = String(req.params['pair'] ?? '').toUpperCase();
  if (!/^[A-Z]{3}_[A-Z]{3}$/.test(pair)) {
    throw new AppError('VALIDATION_ERROR', 400, 'pair must be e.g. VND_USD');
  }

  await fxRateService.deleteOverride(pair, req.user!.userId);
  res.json({ success: true, message: `FX rate override for ${pair} removed` });
});

// ── Gateway Config ────────────────────────────────────────────────────────────

/**
 * GET /api/admin/payments/gateways
 * List all gateway configurations
 */
router.get('/gateways', async (_req: Request, res: Response) => {
  const configs = await prismaRead.gatewayConfig.findMany({ orderBy: { gateway: 'asc' } });
  res.json({ success: true, data: configs });
});

/**
 * PATCH /api/admin/payments/gateways/:gateway
 * Toggle gateway enabled/disabled without code deploys
 * Body: { "isEnabled": false }
 */
router.patch('/gateways/:gateway', async (req: Request, res: Response) => {
  const gateway = req.params['gateway'];
  const validGateways = ['stripe', 'pay2pay', 'tylt_crypto'];
  if (!validGateways.includes(gateway ?? '')) {
    throw new AppError('VALIDATION_ERROR', 400, `gateway must be one of: ${validGateways.join(', ')}`);
  }

  const { isEnabled } = req.body as { isEnabled?: boolean };
  if (typeof isEnabled !== 'boolean') {
    throw new AppError('VALIDATION_ERROR', 400, '"isEnabled" must be a boolean');
  }

  await prismaWrite.gatewayConfig.upsert({
    where:  { gateway: gateway as 'stripe' | 'pay2pay' | 'tylt_crypto' },
    create: {
      gateway:            gateway as 'stripe' | 'pay2pay' | 'tylt_crypto',
      isEnabled,
      displayName:        gateway,
      supportedCurrencies: [],
    },
    update: { isEnabled },
  });

  logger.info({ gateway, isEnabled, adminId: req.user!.userId }, 'Gateway config updated');
  res.json({ success: true, message: `${gateway} ${isEnabled ? 'enabled' : 'disabled'}` });
});

export default router;
