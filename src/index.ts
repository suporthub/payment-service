import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger';
import { config } from './config/env';
import { connectDB, disconnectDB } from './lib/prisma';
import { connectRedis, disconnectRedis } from './lib/redis';
import { connectKafka, disconnectKafka } from './lib/kafka';
import { AppError } from './utils/errors';

// ── Routes ─────────────────────────────────────────────────────────────────────
import depositRoutes  from './routes/deposit.routes';
import webhookRoutes  from './routes/webhook.routes';
import adminRoutes    from './routes/admin.routes';
import internalRoutes from './routes/internal.routes';
import tyltRoutes     from './routes/tylt.routes';

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());

// ── Raw body capture for Webhooks ──────────────────────────────────────────────
// Webhook signature verification requires the raw body buffer.
// We use the 'verify' hook of express.json to capture the raw buffer without draining the stream.
app.use(express.json({
  limit: '2mb',
  verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  }
}));

// ── Request logging ───────────────────────────────────────────────────────────
app.use(pinoHttp({ logger }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'payment-service', ts: new Date().toISOString() });
});

// ── Route mounting ─────────────────────────────────────────────────────────────
// Public prefix grouping that Nginx will route to this service
app.use('/api/payments',            depositRoutes);
// Tylt gateway lookup endpoints (crypto/fiat currencies + networks)
app.use('/api/payments/tylt',       tyltRoutes);
// Webhooks — no auth middleware; HMAC-only
app.use('/webhooks',                webhookRoutes);
// Admin — requires ADMIN_JWT_SECRET token
app.use('/api/admin/payments',      adminRoutes);
// Internal — requires x-service-secret header
app.use('/internal/payments',       internalRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, code: err.code, message: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ success: false, message: 'Invalid JSON body' });
    return;
  }
  logger.error({ err }, 'Unhandled error in payment-service');
  res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  await connectDB();
  await connectRedis();
  await connectKafka();
  logger.info('✅ payment_db, Redis, and Kafka connected');

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, `🚀 payment-service started on :${config.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down payment-service…');
    server.close(async () => {
      await disconnectDB();
      await disconnectRedis();
      await disconnectKafka();
      logger.info('payment-service stopped cleanly');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error({ err }, '❌ Failed to start payment-service');
  process.exit(1);
});
