import crypto from 'crypto';
import axios from 'axios';
import type { IPaymentGateway } from './IPaymentGateway';
import type { CreateDepositParams, GatewayDepositResult, NormalizedGatewayEvent, PaymentGateway } from '../types/payment.types';
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
      settledCurrency:     params.settledCurrency ?? 'USDT',
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

    let data;
    try {
      const response = await axios.post<{ data: Record<string, unknown>; errorCode?: number; msg?: string }>(
        TYLT_API_URL,
        raw,
        { headers, timeout: 15_000 }
      );
      
      if (response.data.errorCode && response.data.errorCode !== 0) {
        throw new AppError('GATEWAY_ERROR', 400, `Tylt API Error: ${response.data.msg || 'Unknown error'}`);
      }
      
      data = response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const msg = err.response.data?.msg || err.response.data?.message || err.message;
        throw new AppError('GATEWAY_ERROR', 400, `Tylt API Error: ${msg}`);
      }
      throw err;
    }

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
  //
  // Real Tylt webhook shape:
  // {
  //   "type": "pay-in",
  //   "data": {
  //     "orderId": "...",          ← Tylt's internal order ID
  //     "merchantOrderId": "...", ← our PAY-xxx reference
  //     "status": "Completed",
  //     "baseAmount": 100,
  //     "baseAmountReceived": 100,    ← gross amount received
  //     "settledAmountCredited": 9.9, ← net after Tylt commission (credit this)
  //     "commission": 0.1,
  //     "network": "BSC",
  //     "transactions": [{ "transactionHash": "0x..." }],
  //     ...
  //   }
  // }

  parseWebhookEvent(rawBody: Buffer, _headers: Record<string, string>): NormalizedGatewayEvent {
    const envelope = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;

    // Tylt wraps the actual data inside a "data" key at the top level.
    // Fall back to the root for any legacy/test payloads without the wrapper.
    const body = (
      envelope['data'] !== null &&
      typeof envelope['data'] === 'object' &&
      !Array.isArray(envelope['data'])
        ? envelope['data']
        : envelope
    ) as Record<string, unknown>;

    const status         = String(body['status'] ?? '');
    const internalStatus = this.mapStatus(status);

    const merchantOrderId = String(body['merchantOrderId'] ?? '');
    const orderId         = String(body['orderId'] ?? '');

    // Gross amount received from the blockchain (before Tylt fee)
    const baseAmountReceived = body['baseAmountReceived'] != null
      ? parseFloat(String(body['baseAmountReceived']))
      : undefined;

    // Net amount credited to merchant AFTER Tylt commission — this is what we credit to the user.
    // For a deposit of 100 USDT with 0.1 commission, this would be 99.9 USDT.
    const settledAmountCredited = body['settledAmountCredited'] != null
      ? parseFloat(String(body['settledAmountCredited']))
      : undefined;

    const commission = body['commission'] != null
      ? parseFloat(String(body['commission']))
      : undefined;

    // Extract first transaction hash if present (for audit trail)
    const transactions = Array.isArray(body['transactions']) ? body['transactions'] : [];
    const firstTxHash  = (transactions[0] as Record<string, unknown> | undefined)?.['transactionHash'];

    logger.info(
      {
        gateway: 'tylt_crypto',
        merchantOrderId,
        orderId,
        status,
        internalStatus,
        baseAmountReceived,
        settledAmountCredited,
        commission,
        network: body['network'],
      },
      '[TyltCryptoAdapter] parseWebhookEvent',
    );

    return {
      providerEventId:     orderId              || undefined,
      eventType:           `crypto.${status.replace(/\s+/g, '_').toLowerCase()}`,
      merchantReferenceId: merchantOrderId      || undefined,
      providerReferenceId: orderId              || undefined,
      internalStatus,
      // paidAmount = gross received from blockchain
      paidAmount:          baseAmountReceived,
      paidCurrency:        String(body['baseCurrency']    ?? '').toUpperCase() || undefined,
      // settledAmount = net after Tylt's commission — credit this to the user
      settledAmount:       settledAmountCredited,
      settledCurrency:     String(body['settledCurrency'] ?? '').toUpperCase() || undefined,
      feeAmount:           commission,
      feeCurrency:         String(body['settledCurrency'] ?? '').toUpperCase() || undefined,
      // Store the full envelope (including the outer "type" field) as raw payload for audit
      rawPayload: {
        ...body,
        _tyltType:       envelope['type'] ?? 'pay-in',
        _transactionHash: firstTxHash  ?? null,
        _network:        body['network'] ?? null,
      },
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Maps Tylt's human-readable status strings to our internal PaymentStatus enum.
   *
   * Note: "Under Payment" / "Over Payment" are still treated as COMPLETED
   * because Tylt settles them and sends settledAmountCredited.
   * The orchestrator will credit the user the net credited amount regardless.
   */
  mapStatus(status: string): NormalizedGatewayEvent['internalStatus'] {
    switch (status.toLowerCase().replace(/\s+/g, ' ').trim()) {
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
