import type { Request, Response } from 'express';
import { Router } from 'express';
import { paymentOrchestrator } from '../services/PaymentOrchestrator';
import { logger } from '../lib/logger';

const router = Router();

// Webhooks are public endpoints — no JWT auth.
// Authentication is done by HMAC/IPN signature verification inside processWebhook.

function buildContext(req: Request): Record<string, string> {
  return {
    ip:        req.ip ?? '',
    userAgent: req.headers['user-agent'] ?? '',
  };
}

// ── Stripe ────────────────────────────────────────────────────────────────────

router.post('/stripe', async (req: Request, res: Response) => {
  const result = await paymentOrchestrator.processWebhook(
    'stripe',
    (req as any).rawBody as Buffer,
    req.headers as Record<string, string>,
    buildContext(req),
  );
  logger.info({ gateway: 'stripe', result }, 'Stripe webhook processed');
  res.json({ received: true });
});

// ── Pay2Pay ───────────────────────────────────────────────────────────────────

router.post('/pay2pay', async (req: Request, res: Response) => {
  const result = await paymentOrchestrator.processWebhook(
    'pay2pay',
    (req as any).rawBody as Buffer,
    req.headers as Record<string, string>,
    buildContext(req),
  );
  logger.info({ gateway: 'pay2pay', result }, 'Pay2Pay IPN processed');
  // Pay2Pay docs require a 200 text response
  res.status(200).send('OK');
});

// ── Tylt Crypto ───────────────────────────────────────────────────────────────

router.post('/tylt', async (req: Request, res: Response) => {
  const result = await paymentOrchestrator.processWebhook(
    'tylt_crypto',
    (req as any).rawBody as Buffer,
    req.headers as Record<string, string>,
    buildContext(req),
  );
  logger.info({ gateway: 'tylt_crypto', result }, 'Tylt webhook processed');
  // Tylt docs require HTTP 200 with body text "ok" (exact lowercase string).
  // Any non-2xx or non-conforming body may cause Tylt to mark the webhook as failed.
  res.status(200).send('ok');
});

export default router;
