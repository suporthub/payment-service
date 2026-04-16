import Stripe from 'stripe';
import crypto from 'crypto';
import type { IPaymentGateway } from './IPaymentGateway';
import type { CreateDepositParams, GatewayDepositResult, NormalizedGatewayEvent, PaymentGateway } from '../types/payment.types';
import { config } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';

const SETTLEMENT_RETRY_ATTEMPTS = 5;
const SETTLEMENT_RETRY_DELAY_MS = 400;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class StripeAdapter implements IPaymentGateway {
  readonly name: PaymentGateway = 'stripe';
  private readonly stripe: Stripe | null = null;

  constructor() {
    if (config.STRIPE_SECRET_KEY) {
      this.stripe = new Stripe(config.STRIPE_SECRET_KEY, {
        apiVersion: config.STRIPE_API_VERSION as Stripe.LatestApiVersion,
      });
    } else {
      logger.warn('STRIPE_SECRET_KEY not configured — Stripe deposits disabled');
    }
  }

  private ensureClient(): Stripe {
    if (!this.stripe) throw new AppError('GATEWAY_DISABLED', 503, 'Stripe is not configured');
    return this.stripe;
  }

  // ── IPaymentGateway: createDeposit ─────────────────────────────────────────

  async createDeposit(params: CreateDepositParams): Promise<GatewayDepositResult> {
    const stripe = this.ensureClient();
    const currency = (params.currency || config.STRIPE_DEPOSIT_CURRENCY).toLowerCase();

    // Convert to integer minor units (Stripe always works in cents/paise/etc.)
    const amountMinor = Math.round(params.amount * 100);
    if (amountMinor <= 0) throw new AppError('INVALID_AMOUNT', 400, 'Amount too small');

    const intentMeta: Record<string, string> = {
      gateway:  'stripe',
      purpose:  'deposit',
      user_id:  params.userId,
      user_type: params.userType,
      ...(params.initiatorUserId && { initiator_user_id: params.initiatorUserId }),
      ...(params.meta ?? {}),
    };

    const reqOptions: Stripe.RequestOptions = {};
    if (params.idempotencyKey) reqOptions.idempotencyKey = params.idempotencyKey;

    const intent = await stripe.paymentIntents.create(
      {
        amount:   amountMinor,
        currency,
        description: params.description ?? 'LiveFXHub wallet deposit',
        metadata: intentMeta,
        automatic_payment_methods: { enabled: true },
      },
      reqOptions,
    );

    logger.info({ gateway: 'stripe', intentId: intent.id, userId: params.userId }, 'PaymentIntent created');

    return {
      clientSecret:        intent.client_secret ?? undefined,
      merchantReferenceId: '',  // Orchestrator fills this in before saving to DB
    };
  }

  // ── IPaymentGateway: verifyWebhook ────────────────────────────────────────

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): void {
    const stripe = this.ensureClient();
    const secret = config.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new AppError('STRIPE_WEBHOOK_NOT_CONFIGURED', 500, 'Stripe webhook secret missing');

    const sig = headers['stripe-signature'] ?? '';
    try {
      stripe.webhooks.constructEvent(rawBody, sig, secret);
    } catch (err) {
      throw new AppError('INVALID_WEBHOOK_SIGNATURE', 400, `Stripe signature invalid: ${(err as Error).message}`);
    }
  }

  // ── IPaymentGateway: parseWebhookEvent ────────────────────────────────────

  parseWebhookEvent(rawBody: Buffer, headers: Record<string, string>): NormalizedGatewayEvent {
    const stripe = this.ensureClient();
    const secret = config.STRIPE_WEBHOOK_SECRET!;
    const event = stripe.webhooks.constructEvent(rawBody, headers['stripe-signature'] ?? '', secret);

    const dataObj = event.data.object as Stripe.PaymentIntent;
    const internalStatus = this.mapStatus(event.type, dataObj.status);

    return {
      providerEventId:     event.id,
      eventType:           event.type,
      merchantReferenceId: dataObj.metadata?.['merchant_reference_id'],
      providerReferenceId: dataObj.id,
      internalStatus,
      paidAmount:    dataObj.amount_received ? dataObj.amount_received / 100 : undefined,
      paidCurrency:  dataObj.currency?.toUpperCase(),
      rawPayload:    event as unknown as Record<string, unknown>,
    };
  }

  // ── Settlement retry logic (used by PaymentOrchestrator after COMPLETED) ──

  async fetchSettlementDetails(paymentIntentId: string): Promise<{
    settledAmount: number;
    settledCurrency: string;
    feeAmount: number;
    feeCurrency: string;
    exchangeRate: number | null;
    chargeId: string;
    balanceTxnId: string;
  }> {
    const stripe = this.ensureClient();
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });

    const latestCharge = intent.latest_charge as Stripe.Charge | null;
    if (!latestCharge) throw new Error('No charge found on PaymentIntent');

    let bt = latestCharge.balance_transaction as Stripe.BalanceTransaction | string | null;
    let attempt = 0;

    while ((typeof bt === 'string' || bt === null) && attempt < SETTLEMENT_RETRY_ATTEMPTS) {
      attempt++;
      await sleep(SETTLEMENT_RETRY_DELAY_MS * attempt);
      const charge = await stripe.charges.retrieve(latestCharge.id, { expand: ['balance_transaction'] });
      bt = charge.balance_transaction as Stripe.BalanceTransaction | null;
    }

    if (!bt || typeof bt === 'string') {
      throw new Error('balance_transaction not available after retries');
    }

    return {
      settledAmount:   bt.net / 100,
      settledCurrency: bt.currency.toUpperCase(),
      feeAmount:       bt.fee / 100,
      feeCurrency:     bt.currency.toUpperCase(),
      exchangeRate:    bt.exchange_rate ?? null,
      chargeId:        latestCharge.id,
      balanceTxnId:    bt.id,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private mapStatus(
    eventType: string,
    intentStatus: string,
  ): NormalizedGatewayEvent['internalStatus'] {
    if (eventType === 'payment_intent.succeeded')       return 'COMPLETED';
    if (eventType === 'payment_intent.payment_failed')  return 'FAILED';
    if (eventType === 'payment_intent.canceled')        return 'CANCELLED';
    if (eventType === 'payment_intent.processing')      return 'PROCESSING';

    if (intentStatus === 'succeeded')               return 'COMPLETED';
    if (intentStatus === 'processing')              return 'PROCESSING';
    if (intentStatus === 'canceled')                return 'CANCELLED';
    if (intentStatus === 'requires_payment_method') return 'FAILED';
    return 'PENDING';
  }

  computePayloadHash(rawBody: Buffer): string {
    return crypto.createHash('sha256').update(rawBody).digest('hex');
  }
}

export const stripeAdapter = new StripeAdapter();
