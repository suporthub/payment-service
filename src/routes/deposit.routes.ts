import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { paymentOrchestrator } from '../services/PaymentOrchestrator';
import { depositIntentSchema, pay2payDepositSchema, cryptoDepositSchema } from '../types/payment.types';
import { AppError } from '../utils/errors';

const router = Router();

// ── Health Check ──────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'payment-service-api', ts: new Date().toISOString() });
});

// ── Stripe — create PaymentIntent ─────────────────────────────────────────────

router.post('/stripe/intent', requireAuth, async (req: Request, res: Response) => {
  const parsed = depositIntentSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 400, parsed.error.errors[0]?.message ?? 'Validation failed');

  const user = req.user!;
  const result = await paymentOrchestrator.initiateDeposit('stripe', {
    userId:           user.userId,
    userType:         user.userType,
    tradingAccountId: parsed.data.tradingAccountId,
    amount:           parsed.data.amount,
    currency:         parsed.data.currency,
    description:      parsed.data.description,
    idempotencyKey:   parsed.data.idempotencyKey,
    meta:             { ip: req.ip ?? '', userAgent: req.headers['user-agent'] ?? '' },
  });

  res.status(201).json({
    success: true,
    data: {
      gatewayPaymentId:    result.gatewayPaymentId,
      merchantReferenceId: result.merchantReferenceId,
      clientSecret:        result.clientSecret,
      amount:              parsed.data.amount,
      currency:            parsed.data.currency,
    },
  });
});

// ── Pay2Pay — create redirect URL ─────────────────────────────────────────────

router.post('/pay2pay/redirect', requireAuth, async (req: Request, res: Response) => {
  const parsed = pay2payDepositSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 400, parsed.error.errors[0]?.message ?? 'Validation failed');

  const user = req.user!;
  const result = await paymentOrchestrator.initiateDeposit('pay2pay', {
    userId:           user.userId,
    userType:         user.userType,
    tradingAccountId: parsed.data.tradingAccountId,
    amount:           parsed.data.amountVnd,
    currency:         'VND',
    description:      parsed.data.description,
    meta:             { ip: req.ip ?? '', userAgent: req.headers['user-agent'] ?? '' },
  });

  res.status(201).json({
    success: true,
    data: {
      gatewayPaymentId:    result.gatewayPaymentId,
      merchantReferenceId: result.merchantReferenceId,
      paymentUrl:          result.paymentUrl,
      amountVnd:           parsed.data.amountVnd,
      estimatedUsd:        result.estimatedUsd,
      fxRate:              result.fxRate,
    },
  });
});

// ── Tylt Crypto — create deposit address ──────────────────────────────────────

router.post('/crypto/address', requireAuth, async (req: Request, res: Response) => {
  const parsed = cryptoDepositSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 400, parsed.error.errors[0]?.message ?? 'Validation failed');

  const user = req.user!;
  const result = await paymentOrchestrator.initiateDeposit('tylt_crypto', {
    userId:           user.userId,
    userType:         user.userType,
    tradingAccountId: parsed.data.tradingAccountId,
    amount:           parsed.data.amount,
    currency:         parsed.data.baseCurrency,
    settledCurrency:  'USDT',
    description:      parsed.data.description,
    networkSymbol:    parsed.data.networkSymbol,
    meta:             { ip: req.ip ?? '', userAgent: req.headers['user-agent'] ?? '' },
  });

  res.status(201).json({
    success: true,
    data: {
      gatewayPaymentId:    result.gatewayPaymentId,
      merchantReferenceId: result.merchantReferenceId,
      depositAddress:      result.depositAddress,
      paymentUrl:          result.paymentUrl,
      expiresAt:           result.expiresAt,
      amount:              parsed.data.amount,
      currency:            parsed.data.baseCurrency,
      network:             parsed.data.networkSymbol,
    },
  });
});

// ── Payment history ───────────────────────────────────────────────────────────

router.get('/history', requireAuth, async (req: Request, res: Response) => {
  const page  = Math.max(1, parseInt(String(req.query['page']  ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10)));

  const result = await paymentOrchestrator.getPaymentHistory(req.user!.userId, page, limit);
  res.json({ success: true, data: result });
});

// ── Single payment status ─────────────────────────────────────────────────────

router.get('/:paymentId', requireAuth, async (req: Request, res: Response) => {
  const payment = await paymentOrchestrator.getPaymentById(req.params['paymentId']!, req.user!.userId);
  if (!payment) throw new AppError('NOT_FOUND', 404, 'Payment not found');
  res.json({ success: true, data: payment });
});

export default router;
