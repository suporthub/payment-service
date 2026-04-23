import crypto from 'crypto';
import axios from 'axios';
import type { IPaymentGateway } from './IPaymentGateway';
import type { CreateDepositParams, GatewayDepositResult, NormalizedGatewayEvent, PaymentGateway } from '../types/payment.types';
import { config } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';
import { fxRateService } from '../services/FxRateService';

// ─────────────────────────────────────────────────────────────────────────────
// Fee calculation (configurable split between platform and customer)
// ─────────────────────────────────────────────────────────────────────────────

interface FeeSplit {
  grossUsd:        number;
  totalFeeVnd:     number;
  totalFeeUsd:     number;
  merchantFeeUsd:  number;
  customerFeeUsd:  number;
  creditUsd:       number;
  merchantSharePct: number;
}

function calculateFees(vndAmount: number, rate: number, ipnFeeVnd: number | null): FeeSplit {
  const grossUsd = vndAmount * rate;
  const feePercent = config.PAY2PAY_MERCHANT_FEE_PERCENT;
  const totalFeeVnd = ipnFeeVnd != null && ipnFeeVnd >= 0
    ? ipnFeeVnd
    : Math.round(vndAmount * (feePercent / 100));

  const totalFeeUsd = totalFeeVnd * rate;
  const merchantSharePct = Math.min(100, Math.max(0, config.PAY2PAY_MERCHANT_FEE_SHARE_PERCENT));
  const merchantFeeUsd = totalFeeUsd * (merchantSharePct / 100);
  const customerFeeUsd = totalFeeUsd * (1 - merchantSharePct / 100);
  const creditUsd = Math.max(0, grossUsd - customerFeeUsd);

  return {
    grossUsd:        round6(grossUsd),
    totalFeeVnd,
    totalFeeUsd:     round6(totalFeeUsd),
    merchantFeeUsd:  round6(merchantFeeUsd),
    customerFeeUsd:  round6(customerFeeUsd),
    creditUsd:       round6(creditUsd),
    merchantSharePct,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature helpers
// ─────────────────────────────────────────────────────────────────────────────

function computeRedirectSignature(params: Record<string, string>, merchantKey: string): string {
  const sorted = Object.keys(params).sort();
  const values = sorted.map(k => params[k]).join('');
  return crypto.createHash('sha256').update(values + merchantKey, 'utf8').digest('base64');
}

function computeIpnSignature(rawBodyStr: string, secretKey: string): string {
  return crypto.createHash('sha256').update(rawBodyStr + secretKey, 'utf8').digest('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class Pay2PayAdapter implements IPaymentGateway {
  readonly name: PaymentGateway = 'pay2pay';

  get isEnabled(): boolean {
    return Boolean(config.PAY2PAY_MERCHANT_KEY && config.PAY2PAY_MERCHANT_ID);
  }

  private ensureEnabled(): void {
    if (!this.isEnabled) throw new AppError('GATEWAY_DISABLED', 503, 'Pay2Pay is not configured');
  }

  // ── IPaymentGateway: createDeposit ─────────────────────────────────────────

  async createDeposit(params: CreateDepositParams): Promise<GatewayDepositResult> {
    this.ensureEnabled();
    if (!config.PAY2PAY_RETURN_URL) throw new AppError('GATEWAY_CONFIG_ERROR', 500, 'PAY2PAY_RETURN_URL not set');

    const intAmount = Math.round(params.amount);
    if (intAmount < config.PAY2PAY_MIN_AMOUNT_VND) {
      throw new AppError('AMOUNT_TOO_SMALL', 400, `Minimum is ${config.PAY2PAY_MIN_AMOUNT_VND.toLocaleString()} VND`);
    }
    if (intAmount > config.PAY2PAY_MAX_AMOUNT_VND) {
      throw new AppError('AMOUNT_TOO_LARGE', 400, `Maximum is ${config.PAY2PAY_MAX_AMOUNT_VND.toLocaleString()} VND`);
    }

    const fxRate = await fxRateService.getVndToUsdRate();
    const fees   = calculateFees(intAmount, fxRate, null);

    const timestamp   = Math.floor(Date.now() / 1000).toString();
    const safeContent = (params.description ?? 'Nap tien giao dich')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim() || 'Nap tien giao dich';

    // merchantReferenceId passed in as params.idempotencyKey (orchestrator sets it)
    const orderCode = params.idempotencyKey ?? '';

    const redirectParams: Record<string, string> = {
      content:      safeContent,
      currency:     'VND',
      language:     'vi',
      merchant_id:  config.PAY2PAY_MERCHANT_ID ?? '',
      order_code:   orderCode,
      timestamp,
      total_amount: intAmount.toString(),
      url_redirect: config.PAY2PAY_RETURN_URL,
    };

    const sig = computeRedirectSignature(redirectParams, config.PAY2PAY_MERCHANT_KEY ?? '');

    const qs = new URLSearchParams();
    Object.keys(redirectParams).sort().forEach(k => qs.append(k, redirectParams[k]!));
    qs.append('signature', sig);

    const paymentUrl = `${config.PAY2PAY_CHECKOUT_DOMAIN}/?${qs.toString()}`;
    logger.info({ gateway: 'pay2pay', orderCode, amountVnd: intAmount, paymentUrl }, 'Pay2Pay redirect URL generated');

    return {
      merchantReferenceId: orderCode,
      paymentUrl,
      estimatedUsd: fees.grossUsd,
      fxRate,
    };
  }

  // ── IPaymentGateway: verifyWebhook (IPN) ─────────────────────────────────

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): void {
    const apiKey    = config.PAY2PAY_API_KEY;
    const secretKey = config.PAY2PAY_IPN_SECRET_KEY;

    if (!apiKey || !secretKey) {
      throw new AppError('GATEWAY_DISABLED', 503, 'Pay2Pay IPN credentials not configured');
    }

    const receivedApiKey = headers['p-api-key'] ?? headers['P-API-KEY'];
    const receivedSig    = headers['p-signature'] ?? headers['P-SIGNATURE'];

    // Step 1: Validate required headers → 400 Bad Request
    if (!receivedApiKey || !receivedSig) {
      throw new AppError('MISSING_SECURITY_HEADERS', 400, 'Missing security headers');
    }

    // Step 2: Validate API key → 401 Unauthorized
    if (receivedApiKey !== apiKey) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid API Key');
    }

    const expectedSig = computeIpnSignature(rawBody.toString('utf8'), secretKey);

    const receivedBuffer = Buffer.from(receivedSig, 'utf8');
    const expectedBuffer = Buffer.from(expectedSig, 'utf8');

    // Prevent timing attacks by using fixed-time equality check
    if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
      throw new AppError('INVALID_WEBHOOK_SIGNATURE', 401, 'Pay2Pay IPN signature mismatch');
    }
  }

  // ── IPaymentGateway: parseWebhookEvent ────────────────────────────────────

  parseWebhookEvent(rawBody: Buffer, _headers: Record<string, string>): NormalizedGatewayEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const status = String(body['status'] ?? '').toUpperCase();

    const internalStatus = this.mapStatus(status);
    const orderId  = String(body['orderId'] ?? '');
    const txnId    = String(body['txnId']   ?? '');
    const amount   = body['amount'] != null ? parseFloat(String(body['amount'])) : undefined;

    // Read the actual fee from the IPN body if Pay2Pay sends it.
    // This matches v1 legacy behaviour: use the real fee when available,
    // fall back to the configured fee % estimate when absent.
    const feeVndFromIpn = body['fee'] != null ? parseFloat(String(body['fee'])) : undefined;

    return {
      providerEventId:     txnId || undefined,
      eventType:           `ipn_${status.toLowerCase()}`,
      merchantReferenceId: orderId || undefined,
      providerReferenceId: txnId   || undefined,
      internalStatus,
      paidAmount:    amount,
      paidCurrency:  'VND',
      // feeAmount here is VND — the orchestrator passes it to calculateFees()
      // which treats it as ipnFeeVnd. If undefined, calculateFees() estimates it.
      feeAmount:     feeVndFromIpn,
      feeCurrency:   'VND',
      rawPayload:    body,
    };
  }

  // ── Transaction inquiry ───────────────────────────────────────────────────

  async inquiryStatus(merchantReferenceId: string): Promise<Record<string, unknown>> {
    this.ensureEnabled();
    const url = `${config.PAY2PAY_DOMAIN}/pgw-transaction-service/mch/api/v2.0/inquiry`;
    const body = JSON.stringify({ orderId: merchantReferenceId });

    const headers = {
      'Content-Type': 'application/json',
      'X-API-KEY':    config.PAY2PAY_API_KEY ?? '',
    };

    const { data } = await axios.post<Record<string, unknown>>(url, body, { headers, timeout: 15_000 });
    logger.info({ gateway: 'pay2pay', merchantReferenceId }, 'Pay2Pay inquiry completed');
    return data;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  mapStatus(status: string): NormalizedGatewayEvent['internalStatus'] {
    switch (status.toUpperCase()) {
      case 'SUCCESS':    return 'COMPLETED';
      case 'FAIL':       return 'FAILED';
      case 'CANCELLED':
      case 'CANCELED':   return 'CANCELLED';
      case 'PROCESSING':
      case 'SUSPECT':    return 'PROCESSING';
      default:           return 'PENDING';
    }
  }

  calculateFees(vndAmount: number, rate: number, ipnFeeVnd: number | null): FeeSplit {
    return calculateFees(vndAmount, rate, ipnFeeVnd);
  }
}

export const pay2payAdapter = new Pay2PayAdapter();
