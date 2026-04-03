import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV:             z.enum(['development', 'production', 'test']).default('development'),
  PORT:                 z.coerce.number().default(3005),
  SERVICE_NAME:         z.string().default('payment-service'),

  // Database
  DATABASE_URL:         z.string().min(1),

  // Redis
  REDIS_URL:            z.string().default('redis://localhost:6379'),

  // Kafka
  KAFKA_BROKERS:        z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID:      z.string().default('payment-service'),

  // JWT
  JWT_SECRET:           z.string().min(1),
  ADMIN_JWT_SECRET:     z.string().min(1),

  // Internal service comms
  INTERNAL_SERVICE_SECRET: z.string().min(1),

  // Logging
  LOG_TO_FILE:          z.string().transform(v => v !== 'false').default('true'),
  LOG_LEVEL:            z.string().default('debug'),

  // Stripe
  STRIPE_SECRET_KEY:           z.string().optional(),
  STRIPE_WEBHOOK_SECRET:       z.string().optional(),
  STRIPE_DEPOSIT_CURRENCY:     z.string().default('USD'),
  STRIPE_API_VERSION:          z.string().default('2024-06-20'),

  // Pay2Pay
  PAY2PAY_API_KEY:             z.string().optional(),
  PAY2PAY_IPN_SECRET_KEY:      z.string().optional(),
  PAY2PAY_MERCHANT_KEY:        z.string().optional(),
  PAY2PAY_MERCHANT_ID:         z.string().optional(),
  PAY2PAY_DOMAIN:              z.string().default('https://api.pay2pay.vn'),
  PAY2PAY_CHECKOUT_DOMAIN:     z.string().default('https://checkout.pay2pay.vn'),
  PAY2PAY_IPN_URL:             z.string().optional(),
  PAY2PAY_RETURN_URL:          z.string().optional(),
  PAY2PAY_MIN_AMOUNT_VND:      z.coerce.number().default(10000),
  PAY2PAY_MAX_AMOUNT_VND:      z.coerce.number().default(500_000_000),
  PAY2PAY_MERCHANT_FEE_PERCENT: z.coerce.number().default(0.5),
  PAY2PAY_MERCHANT_FEE_SHARE_PERCENT: z.coerce.number().default(50),

  // Tylt Crypto
  TYLT_API_KEY:                z.string().optional(),
  TYLT_API_SECRET:             z.string().optional(),
  TYLT_CALLBACK_URL:           z.string().optional(),

  // FX Rate
  VND_TO_USD_FALLBACK_RATE:    z.coerce.number().default(0.000040),
  FX_RATE_CACHE_TTL_SECONDS:   z.coerce.number().default(300),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const config = parsed.data;
