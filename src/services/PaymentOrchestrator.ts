import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { prismaWrite, prismaRead } from '../lib/prisma';
import { publishEvent } from '../lib/kafka';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';
import type { IPaymentGateway } from '../adapters/IPaymentGateway';
import { stripeAdapter } from '../adapters/StripeAdapter';
import { pay2payAdapter } from '../adapters/Pay2PayAdapter';
import { fxRateService } from './FxRateService';
import type {
  CreateDepositParams,
  GatewayDepositResult,
  DepositCompletedEvent,
  PaymentGateway,
} from '../types/payment.types';
import type { GatewayPayment, PaymentStatus } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Gateway registry — O (Open/Closed): add new adapters here, nothing else changes
// ─────────────────────────────────────────────────────────────────────────────

import { tyltCryptoAdapter } from '../adapters/TyltCryptoAdapter';

const gateways: Record<PaymentGateway, IPaymentGateway> = {
  stripe:      stripeAdapter,
  pay2pay:     pay2payAdapter,
  tylt_crypto: tyltCryptoAdapter,
};

function getAdapter(gateway: PaymentGateway): IPaymentGateway {
  const adapter = gateways[gateway];
  if (!adapter) throw new AppError('UNKNOWN_GATEWAY', 400, `Unknown gateway: ${gateway}`);
  return adapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateMerchantRefId(): string {
  return `PAY-${uuid().replace(/-/g, '').toUpperCase().slice(0, 20)}`;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// PaymentOrchestrator
//
// SOLID:
//  D — Depends on IPaymentGateway, not concrete adapters.
//  S — Owns the payment workflow only. FX logic lives in FxRateService.
// ─────────────────────────────────────────────────────────────────────────────

export class PaymentOrchestrator {

  // ── Phase 1: Initiate a deposit ───────────────────────────────────────────

  async initiateDeposit(
    gateway: PaymentGateway,
    params:  CreateDepositParams,
  ): Promise<GatewayDepositResult & { gatewayPaymentId: string }> {
    const adapter = getAdapter(gateway);

    const merchantReferenceId = generateMerchantRefId();
    // Pass merchantReferenceId as idempotencyKey so adapters can embed it in their request
    const paramsWithRef: CreateDepositParams = { ...params, idempotencyKey: merchantReferenceId };

    const result = await adapter.createDeposit(paramsWithRef);

    // Persist pending payment record
    const payment = await prismaWrite.gatewayPayment.create({
      data: {
        merchantReferenceId,
        gateway,
        purpose:          'deposit',
        status:           'PENDING',
        userId:           params.userId,
        userType:         params.userType,
        tradingAccountId: params.tradingAccountId ?? null,
        initiatorUserId:  params.initiatorUserId ?? null,
        requestedAmount:   params.amount,
        requestedCurrency: params.currency.toUpperCase(),
        idempotencyKey:    params.idempotencyKey ?? null,
        providerPayload:   result as any,
        metadata:          params.meta as any ?? null,
      },
    });

    logger.info({ gateway, merchantReferenceId, userId: params.userId, paymentId: payment.id }, 'Payment initiated');

    return { ...result, merchantReferenceId, gatewayPaymentId: payment.id };
  }

  // ── Phase 2: Process inbound webhook/IPN ─────────────────────────────────
  //
  // Idempotency strategy — 4 layered guards:
  //
  // Layer 1 — Hash dedupe (DB unique constraint):
  //   The SHA-256 of the raw body is stored with a UNIQUE constraint.
  //   Byte-for-byte identical retries are rejected at the DB level before any logic runs.
  //
  // Layer 2 — Atomic status lock (UPDATE ... WHERE status NOT IN terminal states):
  //   A raw SQL UPDATE only transitions the row if it is still in a non-terminal state.
  //   0 rows affected = someone else already completed it. This eliminates the race condition
  //   where two concurrent webhooks both pass in-memory status checks.
  //
  // Layer 3 — Status regression protection:
  //   A "Pending" or "Expired" webhook arriving after "Completed" is silently ignored.
  //   We never let a less-significant status overwrite a terminal one.
  //
  // Layer 4 — kafkaPublishedAt flag:
  //   Set atomically after a successful Kafka send. If a webhook is retried and the DB row
  //   already has kafkaPublishedAt set, we skip publishing. This prevents double-crediting
  //   even when Kafka publish succeeded but the response to the gateway timed out.

  async processWebhook(
    gateway:  PaymentGateway,
    rawBody:  Buffer,
    headers:  Record<string, string>,
    context?: Record<string, string>,
  ): Promise<{ ok: boolean; duplicate?: boolean; ignored?: boolean; reason?: string }> {
    const adapter = getAdapter(gateway);

    // ── Step 1: Verify HMAC signature — throws AppError(400) on failure ───────
    adapter.verifyWebhook(rawBody, headers);

    // ── Step 2: Parse the event ───────────────────────────────────────────────
    const event       = adapter.parseWebhookEvent(rawBody, headers);
    const payloadHash = sha256Hex(rawBody);

    // ── Step 3 (Layer 1): Record the raw event with unique hash constraint ────
    // This is the first idempotency gate. Any byte-for-byte identical retry will hit
    // the P2002 unique violation on (gateway, payloadHash) and return 200 immediately.
    let dbEvent;
    try {
      dbEvent = await prismaWrite.gatewayPaymentEvent.create({
        data: {
          gateway,
          providerEventId:     event.providerEventId ?? null,
          eventType:           event.eventType,
          payloadHash,
          merchantReferenceId: event.merchantReferenceId ?? null,
          processingStatus:    'RECEIVED',
          payload:             event.rawPayload as any,
          context:             context as any ?? null,
        },
      });
    } catch (err: unknown) {
      const isUniqueViolation =
        typeof err === 'object' && err !== null && 'code' in err &&
        (err as { code: string }).code === 'P2002';

      if (isUniqueViolation) {
        logger.info({ gateway, eventType: event.eventType, payloadHash }, 'Duplicate webhook (hash match) — skipping');
        return { ok: true, duplicate: true };
      }
      throw err;
    }

    // ── Step 4: Find the payment record ──────────────────────────────────────
    const merchantRef = event.merchantReferenceId;
    const providerRef = event.providerReferenceId;

    let payment: GatewayPayment | null = null;
    if (merchantRef) {
      payment = await prismaWrite.gatewayPayment.findUnique({ where: { merchantReferenceId: merchantRef } });
    }
    if (!payment && providerRef) {
      payment = await prismaWrite.gatewayPayment.findFirst({ where: { gateway, providerReferenceId: providerRef } });
    }

    if (!payment) {
      await prismaWrite.gatewayPaymentEvent.update({
        where: { id: dbEvent.id },
        data:  { processingStatus: 'IGNORED', processedAt: new Date(), processingError: 'Payment not found' },
      });
      logger.warn({ gateway, merchantRef, providerRef }, 'Webhook received but matching payment not found — ignored');
      return { ok: true, ignored: true, reason: 'payment_not_found' };
    }

    // Link raw event to payment for audit trail
    await prismaWrite.gatewayPaymentEvent.update({
      where: { id: dbEvent.id },
      data:  { paymentId: payment.id },
    });

    // ── Step 5 (Layer 3): Status regression protection ───────────────────────
    // Terminal statuses that should never be overwritten by a subsequent webhook.
    const TERMINAL_STATUSES = new Set<string>(['COMPLETED', 'CANCELLED', 'FAILED', 'REFUNDED', 'EXPIRED']);

    if (TERMINAL_STATUSES.has(payment.status)) {
      await prismaWrite.gatewayPaymentEvent.update({
        where: { id: dbEvent.id },
        data:  { processingStatus: 'DUPLICATE', processedAt: new Date(), processingError: `Payment already in terminal status: ${payment.status}` },
      });
      logger.info(
        { gateway, paymentId: payment.id, currentStatus: payment.status, incomingStatus: event.internalStatus },
        'Webhook ignored — payment already in terminal status (status regression protection)',
      );
      return { ok: true, duplicate: true };
    }

    // ── Step 6: Resolve settlement amounts ────────────────────────────────────
    let settledAmount   = event.settledAmount ?? event.paidAmount ?? 0;
    let settledCurrency = event.settledCurrency ?? 'USD';
    let feeAmount       = event.feeAmount ?? null;
    let exchangeRate    = event.exchangeRate ?? null;

    // Stripe: fetch balance_transaction for exact net amounts
    if (gateway === 'stripe' && event.internalStatus === 'COMPLETED' && event.providerReferenceId) {
      try {
        const settlement = await stripeAdapter.fetchSettlementDetails(event.providerReferenceId);
        settledAmount   = settlement.settledAmount;
        settledCurrency = settlement.settledCurrency;
        feeAmount       = settlement.feeAmount;
        exchangeRate    = settlement.exchangeRate ?? null;
      } catch (err) {
        logger.error({ err, paymentId: payment.id }, 'Failed to fetch Stripe settlement details');
        await prismaWrite.gatewayPaymentEvent.update({
          where: { id: dbEvent.id },
          data: { processingStatus: 'FAILED', processedAt: new Date(), processingError: (err as Error).message },
        });
        throw err;
      }
    }

    // Pay2Pay: apply live FX rate to convert VND → USD
    if (gateway === 'pay2pay' && event.internalStatus === 'COMPLETED') {
      const vndAmount = event.paidAmount ?? 0;
      const fxRate    = await fxRateService.getVndToUsdRate();
      const ipnFee    = null;
      const fees      = pay2payAdapter.calculateFees(vndAmount, fxRate, ipnFee);
      settledAmount   = fees.creditUsd;
      settledCurrency = 'USD';
      feeAmount       = fees.totalFeeUsd;
      exchangeRate    = fxRate;
    }

    const creditedAmount = event.internalStatus === 'COMPLETED' ? settledAmount : null;

    // ── Step 7 (Layer 2): Atomic status transition — the race-condition guard ─
    //
    // We use a raw UPDATE with a WHERE clause that checks the current status.
    // If two concurrent webhooks both reach this point, only ONE of them will
    // get count=1 back from Postgres. The other gets count=0 and is treated as a duplicate.
    // This is the industry-standard "compare-and-swap" pattern for financial systems.
    const { count: updatedCount } = await prismaWrite.gatewayPayment.updateMany({
      where: {
        id:     payment.id,
        status: { notIn: [...TERMINAL_STATUSES] as PaymentStatus[] },
      },
      data: {
        status:              event.internalStatus as PaymentStatus,
        paidAmount:          event.paidAmount  ?? null,
        paidCurrency:        event.paidCurrency ?? null,
        settledAmount,
        settledCurrency,
        creditedAmount,
        feeAmount:           feeAmount  ?? null,
        feeCurrency:         settledCurrency,
        fxRate:              exchangeRate ?? null,
        providerReferenceId: event.providerReferenceId ?? payment.providerReferenceId ?? null,
        providerPayload:     event.rawPayload as any,
      },
    });

    if (updatedCount === 0) {
      // Another concurrent webhook already transitioned this payment — this one loses the race.
      await prismaWrite.gatewayPaymentEvent.update({
        where: { id: dbEvent.id },
        data:  { processingStatus: 'DUPLICATE', processedAt: new Date(), processingError: 'Lost atomic update race' },
      });
      logger.info(
        { gateway, paymentId: payment.id },
        'Webhook ignored — lost atomic update race (concurrent duplicate)',
      );
      return { ok: true, duplicate: true };
    }

    // Reload the payment to get the latest state after the update.
    // This is necessary to read the kafkaPublishedAt field from the DB.
    const freshPayment = await prismaWrite.gatewayPayment.findUnique({ where: { id: payment.id } });

    // ── Step 8 (Layer 4): Kafka publish — at-most-once guard ─────────────────
    //
    // We only publish if:
    //   a) The incomingStatus is COMPLETED with a positive creditedAmount
    //   b) kafkaPublishedAt is NULL — meaning we haven't published for this payment yet.
    //
    // If Kafka publish succeeds, we immediately set kafkaPublishedAt so any future retry
    // of this webhook will see the flag and skip publishing.
    //
    // If Kafka publish fails, kafkaPublishedAt stays NULL, a CRITICAL error is logged,
    // and we still return 200 to the gateway. A reconciliation job can detect
    // payments where status=COMPLETED but kafkaPublishedAt IS NULL and re-publish.
    if (event.internalStatus === 'COMPLETED' && creditedAmount && creditedAmount > 0) {
      if (freshPayment?.kafkaPublishedAt) {
        // kafkaPublishedAt is set — Kafka was already published in a previous webhook delivery.
        logger.info(
          { paymentId: payment.id, kafkaPublishedAt: freshPayment.kafkaPublishedAt },
          'Skipping Kafka publish — DEPOSIT_COMPLETED already published (kafkaPublishedAt is set)',
        );
      } else {
        const kafkaEvent: DepositCompletedEvent = {
          eventId:         uuid(),
          type:            'DEPOSIT_COMPLETED',
          paymentId:       payment.id,
          merchantRefId:   payment.merchantReferenceId,
          gateway,
          userId:          payment.userId,
          userType:        payment.userType,
          ...(payment.tradingAccountId ? { tradingAccountId: payment.tradingAccountId } : {}),
          creditAmountUsd: creditedAmount,
          currency:        'USD',
          ...(exchangeRate != null ? { fxRate: exchangeRate } : {}),
          createdAt:       new Date().toISOString(),
        };
        try {
          await publishEvent('payment.events', payment.userId, kafkaEvent as unknown as Record<string, unknown>);
          // Atomically stamp kafkaPublishedAt — this is the single "wallet credit authorised" signal.
          await prismaWrite.gatewayPayment.update({
            where: { id: payment.id },
            data:  { kafkaPublishedAt: new Date() },
          });
          logger.info({ paymentId: payment.id, userId: payment.userId, creditedAmount }, 'DEPOSIT_COMPLETED event published to Kafka');
        } catch (kafkaErr) {
          // kafkaPublishedAt is NOT set. This payment will be caught by the reconciliation job.
          logger.error(
            { paymentId: payment.id, userId: payment.userId, creditedAmount, err: kafkaErr },
            'CRITICAL: Failed to publish DEPOSIT_COMPLETED to Kafka — kafkaPublishedAt not stamped. Manual reconciliation required.',
          );
          // Do NOT rethrow — the DB is already committed, return 200 to the gateway.
        }
      }
    }

    // ── Step 9: Mark event as PROCESSED ──────────────────────────────────────
    await prismaWrite.gatewayPaymentEvent.update({
      where: { id: dbEvent.id },
      data:  { processingStatus: 'PROCESSED', processedAt: new Date() },
    });

    return { ok: true };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async getPaymentById(paymentId: string, userId: string): Promise<GatewayPayment | null> {
    const payment = await prismaRead.gatewayPayment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.userId !== userId) return null;
    return payment;
  }

  async getPaymentHistory(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [payments, total] = await Promise.all([
      prismaRead.gatewayPayment.findMany({
        where:   { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take:    limit,
      }),
      prismaRead.gatewayPayment.count({ where: { userId } }),
    ]);
    return { payments, total, page, limit };
  }

  /** Mark a completed payment as having been linked to a UserTransaction (written by user-service) */
  async linkUserTransaction(paymentId: string, userTxnId: string): Promise<void> {
    await prismaWrite.gatewayPayment.update({
      where: { id: paymentId },
      data:  { linkedUserTxnId: userTxnId },
    });
  }
}

export const paymentOrchestrator = new PaymentOrchestrator();
