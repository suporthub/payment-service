import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Shared payload types (used across layers)
// ─────────────────────────────────────────────────────────────────────────────

/** Information about the authenticated caller injected by the auth middleware. */
export interface AuthenticatedUser {
  userId:   string;
  userType: string;
  email?:   string | undefined;
  role?:    string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway adapter contracts
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentGateway = 'stripe' | 'pay2pay' | 'tylt_crypto';

export interface CreateDepositParams {
  userId:           string;
  userType:         string;
  initiatorUserId?: string | undefined;
  amount:           number;
  /** ISO-4217 or crypto symbol: USD, VND, BTC, ETH, USDT… */
  currency:         string;
  /** Used by Tylt Crypto to define which token the user will actually send (e.g. USDT) */
  settledCurrency?: string | undefined;
  description?:     string | undefined;
  idempotencyKey?:  string | undefined;
  /** Network symbol for Tylt Crypto e.g. "TRC20", "ERC20" */
  networkSymbol?:   string | undefined;
  /** Forward metadata (ip, userAgent) from original HTTP request */
  meta?:            Record<string, string> | undefined;
}

export interface GatewayDepositResult {
  /** Our merchantReferenceId. Callers should store this for status polling. */
  merchantReferenceId: string;
  /** Stripe: clientSecret; Pay2Pay/Tylt: undefined (redirect or address given) */
  clientSecret?:       string | undefined;
  /** Pay2Pay: hosted payment URL; Tylt: payment URL */
  paymentUrl?:         string | undefined;
  /** Tylt Crypto: the deposit wallet address */
  depositAddress?:     string | undefined;
  /** Tylt: when the address expires */
  expiresAt?:          string | undefined;
  /** Tylt: estimated settlement amount */
  estimatedAmount?:    number | undefined;
  /** Pay2Pay: estimated USD from VND requested */
  estimatedUsd?:       number | undefined;
  fxRate?:             number | undefined;
}

export interface NormalizedGatewayEvent {
  /** Gateway's unique event ID (Stripe evt_xxx / Tylt txnId). Null for Pay2Pay IPN. */
  providerEventId?:     string | undefined;
  /** e.g. "payment_intent.succeeded" / "ipn_success" / "crypto.completed" */
  eventType:            string;
  /** Our merchantReferenceId extracted from the payload */
  merchantReferenceId?: string | undefined;
  /** Gateway's own reference (PaymentIntentId / txnId) */
  providerReferenceId?: string | undefined;
  /** Mapped internal status */
  internalStatus:       'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  /** Amount actually received/charged */
  paidAmount?:          number | undefined;
  paidCurrency?:        string | undefined;
  /** Settlement details (Stripe provides these from balance_transaction) */
  settledAmount?:       number | undefined;
  settledCurrency?:     string | undefined;
  feeAmount?:           number | undefined;
  feeCurrency?:         string | undefined;
  exchangeRate?:        number | undefined;
  /** Raw gateway payload — stored verbatim in GatewayPaymentEvent */
  rawPayload:           Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kafka event: payment.events
// ─────────────────────────────────────────────────────────────────────────────

export interface DepositCompletedEvent {
  eventId:         string;  // UUID — dedup key for downstream consumers
  type:            'DEPOSIT_COMPLETED';
  paymentId:       string;
  merchantRefId:   string;
  gateway:         string;
  userId:          string;
  userType:        string;
  creditAmountUsd: number;
  currency:        'USD';
  fxRate?:         number | undefined;
  createdAt:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas for HTTP request validation
// ─────────────────────────────────────────────────────────────────────────────

export const depositIntentSchema = z.object({
  amount:          z.number().positive(),
  currency:        z.string().min(2).max(10).toUpperCase(),
  description:     z.string().max(255).optional(),
  idempotencyKey:  z.string().max(128).optional(),
});
export type DepositIntentInput = z.infer<typeof depositIntentSchema>;

export const pay2payDepositSchema = z.object({
  amountVnd:   z.number().int().positive(),
  description: z.string().max(255).optional(),
});
export type Pay2PayDepositInput = z.infer<typeof pay2payDepositSchema>;

const depositBaseSchema = z.object({
  amount:      z.number().positive(),
  description: z.string().max(255).optional(),
});

export const cryptoDepositSchema = depositBaseSchema.extend({
  baseCurrency:    z.string().min(3).max(10),
  networkSymbol:   z.string().min(1).max(20),
});
export type CryptoDepositInput = z.infer<typeof cryptoDepositSchema>;

export const fxRateOverrideSchema = z.object({
  pair:   z.string().regex(/^[A-Z]{3}_[A-Z]{3}$/, 'pair must be e.g. VND_USD'),
  rate:   z.number().positive(),
  reason: z.string().max(255).optional(),
});
export type FxRateOverrideInput = z.infer<typeof fxRateOverrideSchema>;
