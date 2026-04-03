import { CreateDepositParams, GatewayDepositResult, NormalizedGatewayEvent, PaymentGateway } from '../types/payment.types';

/**
 * IPaymentGateway — the single contract all gateway adapters must implement.
 *
 * SOLID:
 *  - Single Responsibility: each adapter owns exactly one gateway's logic.
 *  - Open/Closed: add a new gateway by creating a new adapter — zero changes to orchestrator.
 *  - Liskov Substitution: adapters are interchangeable wherever IPaymentGateway is accepted.
 *  - Interface Segregation: only methods every adapter must support. Gateway-specific helpers
 *    (e.g. StripeAdapter.getSettlementDetails) are kept private inside the adapter.
 *  - Dependency Inversion: PaymentOrchestrator depends on this interface, not a concrete class.
 */
export interface IPaymentGateway {
  /** Unique gateway identifier — used as FK in DB and Kafka events */
  readonly name: PaymentGateway;

  /**
   * Initiate a deposit.
   * Returns a GatewayDepositResult containing whichever fields are relevant
   * to the gateway (clientSecret for Stripe, paymentUrl for Pay2Pay/Tylt, etc.)
   */
  createDeposit(params: CreateDepositParams): Promise<GatewayDepositResult>;

  /**
   * Verify the inbound webhook/IPN signature.
   * MUST throw an Error (which the caller maps to HTTP 400) if the signature is invalid.
   * Does NOT parse the body — only validates authenticity.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): void;

  /**
   * Parse a verified webhook/IPN body into a normalised, gateway-agnostic event.
   * The orchestrator calls this AFTER verifyWebhook succeeds.
   */
  parseWebhookEvent(rawBody: Buffer, headers: Record<string, string>): NormalizedGatewayEvent;
}
