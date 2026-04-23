import type { Request, Response } from 'express';
import { Router } from 'express';
import { requireInternalSecret } from '../middleware/auth.middleware';
import { paymentOrchestrator } from '../services/PaymentOrchestrator';
import { AppError } from '../utils/errors';

const router = Router();

/**
 * POST /internal/payments/link-transaction
 * Called by user-service after it creates the UserTransaction record to
 * back-fill the linkedUserTxnId field on GatewayPayment for reconciliation.
 */
router.post('/link-transaction', requireInternalSecret, async (req: Request, res: Response) => {
  const { paymentId, userTxnId } = req.body as { paymentId?: string; userTxnId?: string };
  if (!paymentId || !userTxnId) {
    throw new AppError('VALIDATION_ERROR', 400, 'paymentId and userTxnId are required');
  }
  await paymentOrchestrator.linkUserTransaction(paymentId, userTxnId);
  res.json({ success: true });
});

export default router;
