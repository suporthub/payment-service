import axios from 'axios';
import { redis } from '../lib/redis';
import { prismaWrite, prismaRead } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config/env';
import { AppError } from '../utils/errors';
import { FxRateOverrideInput } from '../types/payment.types';

const REDIS_KEY_PREFIX = 'fx:rate:';

/**
 * FxRateService — Single Responsibility: fetch, cache, and override FX rates.
 *
 * Flow (VND→USD as example):
 *  1. Check DB FxRateOverride table (admin manual override — highest priority)
 *  2. Check Redis cache (live rate from last successful fetch)
 *  3. Fetch live rate from external API (exchangerate-api / open.er-api.com)
 *  4. Fall back to env config variable as last resort
 */
export class FxRateService {
  /** Fetch the VND→USD conversion rate using the priority chain above. */
  async getRate(fromCurrency: string, toCurrency: string): Promise<number> {
    const pair = `${fromCurrency.toUpperCase()}_${toCurrency.toUpperCase()}`;

    // 1. Admin override in DB (highest priority)
    const override = await prismaRead.fxRateOverride.findUnique({ where: { pair } });
    if (override) {
      logger.debug({ pair, rate: override.rate, source: 'db_override' }, 'FX rate from admin override');
      return Number(override.rate);
    }

    // 2. Redis cache
    const cached = await redis.get(`${REDIS_KEY_PREFIX}${pair}`);
    if (cached) {
      const rate = parseFloat(cached);
      if (Number.isFinite(rate) && rate > 0) {
        logger.debug({ pair, rate, source: 'redis_cache' }, 'FX rate from Redis cache');
        return rate;
      }
    }

    // 3. Live fetch from open.er-api.com (free, no key needed for common pairs)
    try {
      const response = await axios.get<{ rates: Record<string, number>; result: string }>(
        `https://open.er-api.com/v6/latest/${fromCurrency.toUpperCase()}`,
        { timeout: 5000 },
      );

      const rate = response.data?.rates?.[toCurrency.toUpperCase()];
      if (!rate || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Rate not found in response for ${pair}`);
      }

      // Cache with TTL
      await redis.setex(
        `${REDIS_KEY_PREFIX}${pair}`,
        config.FX_RATE_CACHE_TTL_SECONDS,
        String(rate),
      );
      logger.info({ pair, rate, source: 'live_api' }, 'FX rate fetched from API and cached');
      return rate;
    } catch (err) {
      logger.warn({ pair, err }, 'Live FX rate fetch failed — using fallback');
    }

    // 4. Env fallback
    if (pair === 'VND_USD') {
      return config.VND_TO_USD_FALLBACK_RATE;
    }
    if (pair === 'USD_USD') {
      return 1;
    }

    throw new AppError('FX_RATE_UNAVAILABLE', 503, `FX rate for ${pair} is unavailable`);
  }

  /** Convenience shorthand used by Pay2Pay adapter */
  async getVndToUsdRate(): Promise<number> {
    return this.getRate('VND', 'USD');
  }

  // ── Admin endpoints ─────────────────────────────────────────────────────────

  /** Set or update an admin override for an FX rate pair. */
  async setOverride(input: FxRateOverrideInput & { adminId: string }): Promise<void> {
    const pair = input.pair.toUpperCase();
    await prismaWrite.fxRateOverride.upsert({
      where:  { pair },
      create: { pair, rate: input.rate, setByAdminId: input.adminId, reason: input.reason ?? null },
      update: { rate: input.rate, setByAdminId: input.adminId, reason: input.reason ?? null },
    });
    // Also update Redis so the cache instantly reflects the new override
    await redis.setex(
      `${REDIS_KEY_PREFIX}${pair}`,
      config.FX_RATE_CACHE_TTL_SECONDS,
      String(input.rate),
    );
    logger.info({ pair, rate: input.rate, adminId: input.adminId }, 'FX rate override set by admin');
  }

  /** Remove an admin override, reverting to live-fetched rate. */
  async deleteOverride(pair: string, adminId: string): Promise<void> {
    const normalised = pair.toUpperCase();
    await prismaWrite.fxRateOverride.deleteMany({ where: { pair: normalised } });
    await redis.del(`${REDIS_KEY_PREFIX}${normalised}`);
    logger.info({ pair: normalised, adminId }, 'FX rate override removed by admin');
  }

  /** List all active admin overrides (for the admin dashboard). */
  async listOverrides() {
    return prismaRead.fxRateOverride.findMany({ orderBy: { pair: 'asc' } });
  }

  /** Get the current effective rate for a pair along with its source. */
  async getRateWithSource(fromCurrency: string, toCurrency: string): Promise<{
    rate: number;
    source: 'db_override' | 'redis_cache' | 'live_api' | 'fallback';
    pair: string;
  }> {
    const pair = `${fromCurrency.toUpperCase()}_${toCurrency.toUpperCase()}`;

    const override = await prismaRead.fxRateOverride.findUnique({ where: { pair } });
    if (override) return { rate: Number(override.rate), source: 'db_override', pair };

    const cached = await redis.get(`${REDIS_KEY_PREFIX}${pair}`);
    if (cached) {
      const rate = parseFloat(cached);
      if (Number.isFinite(rate) && rate > 0) return { rate, source: 'redis_cache', pair };
    }

    // Try live — if that throws, check fallback
    try {
      const rate = await this.getRate(fromCurrency, toCurrency);
      return { rate, source: 'live_api', pair };
    } catch {
      if (pair === 'VND_USD') return { rate: config.VND_TO_USD_FALLBACK_RATE, source: 'fallback', pair };
      throw new AppError('FX_RATE_UNAVAILABLE', 503, `FX rate for ${pair} is unavailable`);
    }
  }
}

export const fxRateService = new FxRateService();
