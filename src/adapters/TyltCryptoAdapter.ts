import crypto from 'crypto';
import axios from 'axios';
import { IPaymentGateway } from './IPaymentGateway';
import { CreateDepositParams, GatewayDepositResult, NormalizedGatewayEvent, PaymentGateway } from '../types/payment.types';
import { config } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';

const TYLT_API_URL = 'https://api.tylt.money/transactions/merchant/createPayinRequest';

export class TyltCryptoAdapter implements IPaymentGateway {
  readonly name: PaymentGateway = 'tylt_crypto';

  get isEnabled(): boolean {
    return Boolean(config.TYLT_API_KEY && config.TYLT_API_SECRET);
  }

  private ensureEnabled(): void {
    if (!this.isEnabled) throw new AppError('GATEWAY_DISABLED', 503, 'Tylt Crypto is not configured');
  }

  private createSignature(secret: string, data: string): string {
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  // ── IPaymentGateway: createDeposit ─────────────────────────────────────────

  async createDeposit(params: CreateDepositParams): Promise<GatewayDepositResult> {
    this.ensureEnabled();

    if (!params.networkSymbol) {
      throw new AppError('MISSING_NETWORK_SYMBOL', 400, 'networkSymbol is required for crypto deposits');
    }

    const merchantOrderId = params.idempotencyKey ?? ''; // Orchestrator always sets this

    const requestBody = {
      merchantOrderId,
      baseAmount:          params.amount,
      baseCurrency:        params.currency,
      settledCurrency:     params.settledCurrency ?? 'USD',
      networkSymbol:       params.networkSymbol,
      callBackUrl:         config.TYLT_CALLBACK_URL ?? '',
      settleUnderpayment:  1,
      ...(params.description && { comments: params.description }),
    };

    const raw       = JSON.stringify(requestBody);
    const signature = this.createSignature(config.TYLT_API_SECRET ?? '', raw);

    const headers = {
      'X-TLP-APIKEY':     config.TYLT_API_KEY ?? '',
      'X-TLP-SIGNATURE':  signature,
      'Content-Type':     'application/json',
      'User-Agent':       'LiveFXHub-PaymentService/3.0',
    };

    logger.info({ gateway: 'tylt_crypto', merchantOrderId, userId: params.userId }, 'Creating Tylt deposit request');

    const { data } = await axios.post<{ data: Record<string, unknown> }>(TYLT_API_URL, raw, { headers, timeout: 15_000 });
    const tyltData = data.data;

    if (!tyltData || !tyltData['paymentURL']) {
      throw new AppError('GATEWAY_ERROR', 502, 'Invalid response from Tylt API');
    }

    return {
      merchantReferenceId: merchantOrderId,
      paymentUrl:    String(tyltData['paymentURL'] ?? ''),
      depositAddress: String(tyltData['depositAddress'] ?? ''),
      expiresAt:     String(tyltData['expiresAt'] ?? ''),
    };
  }

  // ── IPaymentGateway: verifyWebhook ────────────────────────────────────────

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): void {
    const secret = config.TYLT_API_SECRET;
    if (!secret) {
      throw new AppError('GATEWAY_DISABLED', 503, 'Tylt API secret not configured');
    }

    const received = headers['x-tlp-signature'] ?? headers['X-TLP-SIGNATURE'] ?? '';
    const expected = this.createSignature(secret, rawBody.toString('utf8'));

    if (received !== expected) {
      throw new AppError('INVALID_WEBHOOK_SIGNATURE', 400, 'Tylt webhook HMAC signature mismatch');
    }
  }

  // ── IPaymentGateway: parseWebhookEvent ────────────────────────────────────

  parseWebhookEvent(rawBody: Buffer, _headers: Record<string, string>): NormalizedGatewayEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const status = String(body['status'] ?? '');

    const internalStatus = this.mapStatus(status);

    const merchantOrderId = String(body['merchantOrderId'] ?? '');
    const orderId         = String(body['orderId'] ?? '');
    const baseReceived    = body['baseAmountReceived'] != null
      ? parseFloat(String(body['baseAmountReceived']))
      : undefined;

    return {
      providerEventId:     orderId   || undefined,
      eventType:           `crypto.${status.toLowerCase()}`,
      merchantReferenceId: merchantOrderId || undefined,
      providerReferenceId: orderId   || undefined,
      internalStatus,
      paidAmount:    baseReceived,
      paidCurrency:  String(body['baseCurrency'] ?? '').toUpperCase() || undefined,
      rawPayload:    body,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  mapStatus(status: string): NormalizedGatewayEvent['internalStatus'] {
    switch (status.toLowerCase()) {
      case 'completed':
      case 'paid':
      case 'success':
      case 'underpayment':
      case 'under payment':
      case 'overpayment':
      case 'over payment': return 'COMPLETED';
      case 'processing':
      case 'confirming':   return 'PROCESSING';
      case 'failed':       return 'FAILED';
      case 'cancelled':
      case 'expired':      return 'CANCELLED';
      default:             return 'PENDING';
    }
  }

  validateWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const secret = config.TYLT_API_SECRET ?? '';
    const expected = this.createSignature(secret, rawBody.toString('utf8'));
    return expected === signature;
  }
}

export const tyltCryptoAdapter = new TyltCryptoAdapter();
