import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from './logger';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err) => logger.error({ err }, 'Redis connection error'));

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
