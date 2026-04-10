import axios from 'axios';
import crypto from 'crypto';
import {
  ITyltCurrencyService,
  TyltBaseCurrency,
  TyltCryptoCurrency,
  TyltCryptoNetwork,
  TyltFiatCurrency,
} from './ITyltCurrencyService';
import { config } from '../config/env';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';

// ─── Constants ────────────────────────────────────────────────────────────────

const TYLT_BASE_URL = 'https://api.tylt.money/transactions/merchant';

const ENDPOINTS = {
  cryptoCurrencies: `${TYLT_BASE_URL}/getSupportedCryptoCurrenciesList`,
  fiatCurrencies:   `${TYLT_BASE_URL}/getSupportedFiatCurrenciesList`,
  cryptoNetworks:   `${TYLT_BASE_URL}/getSupportedCryptoNetworksList`,
  baseCurrencies:   `${TYLT_BASE_URL}/getSupportedBaseCurrenciesList`,
} as const;

const CACHE_KEYS = {
  cryptoCurrencies: 'tylt:currencies:crypto',
  fiatCurrencies:   'tylt:currencies:fiat',
  cryptoNetworks:   'tylt:networks:crypto',
  baseCurrencies:   'tylt:currencies:base',
} as const;

/**
 * TTL for Tylt lookup lists in Redis cache.
 *
 * These lists change infrequently (gateway adds/removes currencies rarely).
 * 1 hour avoids hammering Tylt's API while keeping data reasonably fresh.
 * Override via TYLT_CURRENCY_CACHE_TTL_SECONDS env var if needed.
 */
const CACHE_TTL_SECONDS = parseInt(
  process.env['TYLT_CURRENCY_CACHE_TTL_SECONDS'] ?? '3600',
  10,
);

// ─── TyltCurrencyService (concrete) ──────────────────────────────────────────

/**
 * TyltCurrencyService — fetches, caches, and returns Tylt's supported
 * currency and network lookup lists.
 *
 * SOLID:
 *  - Single Responsibility (SRP): owns exactly one concern—Tylt lookup lists.
 *    HTTP calls, caching, and signing are all private implementation details.
 *  - Open/Closed (OCP): new endpoints can be added without modifying callers.
 *  - Liskov Substitution (LSP): satisfies ITyltCurrencyService contract fully.
 *  - Dependency Inversion (DIP): depends on `redis` (abstraction proxy) and
 *    `axios`, not on any concrete infrastructure class.
 */
export class TyltCurrencyService implements ITyltCurrencyService {
  // ── Private helpers ─────────────────────────────────────────────────────────

  private get apiKey(): string {
    return config.TYLT_API_KEY ?? '';
  }

  private get apiSecret(): string {
    return config.TYLT_API_SECRET ?? '';
  }

  /**
   * All Tylt lookup endpoints sign an empty `{}` payload.
   * The signature is HMAC-SHA256 of the JSON-stringified request body.
   */
  private buildSignature(): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update('{}')
      .digest('hex');
  }

  private buildHeaders(): Record<string, string> {
    return {
      'X-TLP-APIKEY':     this.apiKey,
      'X-TLP-SIGNATURE':  this.buildSignature(),
      'User-Agent':       'LiveFXHub-PaymentService/3.0',
    };
  }

  /**
   * Generic fetch-with-cache helper.
   *
   * Flow:
   *  1. Try reading from Redis (cache-aside pattern).
   *  2. On cache hit  → parse and return immediately.
   *  3. On cache miss → call Tylt, store in Redis with TTL, return.
   *  4. On Tylt error → log and re-throw as AppError (never swallow silently).
   */
  private async fetchWithCache<T>(
    cacheKey: string,
    endpoint: string,
    logLabel: string,
  ): Promise<T[]> {
    // ── 1. Cache hit ───────────────────────────────────────────────────────────
    try {
      const cached = await (redis as any).get(cacheKey);
      if (cached) {
        logger.debug({ cacheKey, logLabel }, 'Tylt lookup served from cache');
        return JSON.parse(cached) as T[];
      }
    } catch (cacheErr) {
      // Redis failure must never block the request — fall through to live fetch.
      logger.warn({ err: cacheErr, cacheKey }, 'Redis read failed for Tylt cache; falling back to live fetch');
    }

    // ── 2. Ensure Tylt gateway is configured ──────────────────────────────────
    if (!this.apiKey || !this.apiSecret) {
      throw new AppError(
        'GATEWAY_DISABLED',
        503,
        'Tylt Crypto gateway is not configured (missing API key / secret)',
      );
    }

    // ── 3. Live fetch from Tylt ───────────────────────────────────────────────
    logger.info({ logLabel, endpoint }, 'Fetching Tylt lookup list (cache miss)');

    let data: T[];

    try {
      const response = await axios.get<{ data: T[]; errorCode: number; msg: string }>(
        endpoint,
        {
          headers: this.buildHeaders(),
          timeout: 15_000,
        },
      );

      if (response.data.errorCode !== 0) {
        throw new AppError(
          'GATEWAY_ERROR',
          502,
          `Tylt API error [${response.data.errorCode}]: ${response.data.msg || 'unknown'}`,
        );
      }

      data = response.data.data;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error({ err, logLabel }, 'Tylt lookup request failed');
      throw new AppError('GATEWAY_UNAVAILABLE', 502, `Failed to fetch ${logLabel} from Tylt`);
    }

    // ── 4. Populate cache ──────────────────────────────────────────────────────
    try {
      await (redis as any).set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL_SECONDS);
      logger.debug({ cacheKey, logLabel, ttl: CACHE_TTL_SECONDS }, 'Tylt lookup cached');
    } catch (cacheErr) {
      // Cache write failure is non-fatal; we still return the live data.
      logger.warn({ err: cacheErr, cacheKey }, 'Redis write failed for Tylt cache');
    }

    return data;
  }

  // ── ITyltCurrencyService implementation ─────────────────────────────────────

  getCryptoCurrencies(): Promise<TyltCryptoCurrency[]> {
    return this.fetchWithCache<TyltCryptoCurrency>(
      CACHE_KEYS.cryptoCurrencies,
      ENDPOINTS.cryptoCurrencies,
      'SupportedCryptoCurrencies',
    );
  }

  getFiatCurrencies(): Promise<TyltFiatCurrency[]> {
    return this.fetchWithCache<TyltFiatCurrency>(
      CACHE_KEYS.fiatCurrencies,
      ENDPOINTS.fiatCurrencies,
      'SupportedFiatCurrencies',
    );
  }

  getCryptoNetworks(): Promise<TyltCryptoNetwork[]> {
    return this.fetchWithCache<TyltCryptoNetwork>(
      CACHE_KEYS.cryptoNetworks,
      ENDPOINTS.cryptoNetworks,
      'SupportedCryptoNetworks',
    );
  }

  getBaseCurrencies(): Promise<TyltBaseCurrency[]> {
    return this.fetchWithCache<TyltBaseCurrency>(
      CACHE_KEYS.baseCurrencies,
      ENDPOINTS.baseCurrencies,
      'SupportedBaseCurrencies',
    );
  }
}

// Singleton export — instantiated once, reused across all route handlers.
export const tyltCurrencyService = new TyltCurrencyService();
