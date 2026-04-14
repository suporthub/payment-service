import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { prismaWrite, prismaRead } from '../lib/prisma';
import { publishEvent } from '../lib/kafka';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';
import { IPaymentGateway } from '../adapters/IPaymentGateway';
import { stripeAdapter } from '../adapters/StripeAdapter';
import { pay2payAdapter } from '../adapters/Pay2PayAdapter';
import { fxRateService } from './FxRateService';
import {
  CreateDepositParams,
  GatewayDepositResult,
  DepositCompletedEvent,
  PaymentGateway,
} from '../types/payment.types';
import { GatewayPayment, PaymentStatus } from '@prisma/client';

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

  async processWebhook(
    gateway:  PaymentGateway,
    rawBody:  Buffer,
    headers:  Record<string, string>,
    context?: Record<string, string>,
  ): Promise<{ ok: boolean; duplicate?: boolean; ignored?: boolean; reason?: string }> {
    const adapter = getAdapter(gateway);

    // Step 1: Verify signature — throws AppError on failure
    adapter.verifyWebhook(rawBody, headers);

    // Step 2: Parse the event
    const event = adapter.parseWebhookEvent(rawBody, headers);
    const payloadHash = sha256Hex(rawBody);

    // Step 3: Record the raw event (idempotency via unique constraint)
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
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'P2002';

      if (isUniqueViolation) {
        logger.info({ gateway, eventType: event.eventType }, 'Duplicate webhook received — skipping');
        return { ok: true, duplicate: true };
      }
      throw err;
    }

    // Step 4: Find the payment
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
      logger.warn({ gateway, merchantRef, providerRef }, 'Webhook received but payment not found');
      return { ok: true, ignored: true, reason: 'payment_not_found' };
    }

    // Link event to payment
    await prismaWrite.gatewayPaymentEvent.update({
      where: { id: dbEvent.id },
      data:  { paymentId: payment.id },
    });

    // Step 5: Application-level idempotency guard
    if (payment.status === 'COMPLETED') {
      await prismaWrite.gatewayPaymentEvent.update({
        where: { id: dbEvent.id },
        data:  { processingStatus: 'DUPLICATE', processedAt: new Date(), processingError: 'Payment already COMPLETED' },
      });
      return { ok: true, duplicate: true };
    }

    // Step 6: Resolve settlement amounts
    let settledAmount  = event.settledAmount  ?? event.paidAmount  ?? 0;
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
      const ipnFee    = null; // fee from IPN body if present
      const fees      = pay2payAdapter.calculateFees(vndAmount, fxRate, ipnFee);
      settledAmount   = fees.creditUsd;
      settledCurrency = 'USD';
      feeAmount       = fees.totalFeeUsd;
      exchangeRate    = fxRate;
    }

    // Step 7: Update payment record
    const creditedAmount = event.internalStatus === 'COMPLETED' ? settledAmount : null;

    await prismaWrite.gatewayPayment.update({
      where: { id: payment.id },
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

    // Step 8: Emit Kafka event if deposit completed
    if (event.internalStatus === 'COMPLETED' && creditedAmount && creditedAmount > 0) {
      const kafkaEvent: DepositCompletedEvent = {
        eventId:         uuid(),
        type:            'DEPOSIT_COMPLETED',
        paymentId:       payment.id,
        merchantRefId:   payment.merchantReferenceId,
        gateway,
        userId:          payment.userId,
        userType:        payment.userType,
        // exactOptionalPropertyTypes: omit the key entirely if null/undefined
        // rather than explicitly setting it to undefined
        ...(payment.tradingAccountId ? { tradingAccountId: payment.tradingAccountId } : {}),
        creditAmountUsd: creditedAmount,
        currency:        'USD',
        ...(exchangeRate != null ? { fxRate: exchangeRate } : {}),
        createdAt:       new Date().toISOString(),
      };
      await publishEvent('payment.events', payment.userId, kafkaEvent as unknown as Record<string, unknown>);
      logger.info({ paymentId: payment.id, userId: payment.userId, creditedAmount }, 'DEPOSIT_COMPLETED event published');
    }

    // Step 9: Mark event processed
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
