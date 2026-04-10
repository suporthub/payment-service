/**
 * tylt.routes.ts — Tylt supported-currency & network lookup endpoints.
 *
 * These routes proxy Tylt's public lookup APIs so that the frontend never
 * needs to hold API credentials. Results are cached in Redis for 1 hour
 * (configurable via TYLT_CURRENCY_CACHE_TTL_SECONDS).
 *
 * Endpoints
 * ─────────
 *  GET /api/payments/tylt/currencies/crypto    → TyltCryptoCurrency[]
 *  GET /api/payments/tylt/currencies/fiat      → TyltFiatCurrency[]
 *  GET /api/payments/tylt/currencies/base      → TyltBaseCurrency[]
 *  GET /api/payments/tylt/networks             → TyltCryptoNetwork[]
 *
 * SOLID:
 *  - SRP: route file only maps HTTP verbs → service methods → JSON responses.
 *  - DIP: depends on ITyltCurrencyService, not the concrete class.
 *  - OCP: add endpoints by adding route handlers; zero changes to the service.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { ITyltCurrencyService } from '../services/ITyltCurrencyService';
import { tyltCurrencyService } from '../services/TyltCurrencyService';

// ─────────────────────────────────────────────────────────────────────────────
// Factory — injectable for tests; defaults to the production singleton.
// ─────────────────────────────────────────────────────────────────────────────

export function createTyltRoutes(
  service: ITyltCurrencyService = tyltCurrencyService,
): Router {
  const router = Router();

  // ── GET /tylt/currencies/crypto ─────────────────────────────────────────────
  // Returns the list of supported crypto currencies, each with its available
  // blockchain networks, deposit/withdrawal limits, and contract addresses.
  // Frontend usage: populate the `settledCurrency` + `networkSymbol` dropdowns.
  router.get('/currencies/crypto', requireAuth, async (_req: Request, res: Response) => {
    const data = await service.getCryptoCurrencies();
    res.json({ success: true, data });
  });

  // ── GET /tylt/currencies/fiat ───────────────────────────────────────────────
  // Returns the list of supported fiat currencies.
  // Frontend usage: populate `baseCurrency` when the source price is in fiat
  // (e.g. "user pays USD 100 worth of USDT").
  router.get('/currencies/fiat', requireAuth, async (_req: Request, res: Response) => {
    const data = await service.getFiatCurrencies();
    res.json({ success: true, data });
  });

  // ── GET /tylt/currencies/base ───────────────────────────────────────────────
  // Returns the complete base currency list (CRYPTO + FIAT combined).
  // Frontend usage: the primary `baseCurrency` picker for Pay-In request forms.
  router.get('/currencies/base', requireAuth, async (_req: Request, res: Response) => {
    const data = await service.getBaseCurrencies();
    res.json({ success: true, data });
  });

  // ── GET /tylt/networks ──────────────────────────────────────────────────────
  // Returns the list of supported blockchain networks specifically for USDT.
  // Frontend usage: standalone network filter / display labels.
  router.get('/networks', requireAuth, async (_req: Request, res: Response) => {
    const cryptos = await service.getCryptoCurrencies();
    const usdt = cryptos.find(c => c.currencySymbol.toUpperCase() === 'USDT');
    
    const networks = usdt?.networks.map(n => ({
      networkName: n.networkName,
      networkSymbol: n.networkSymbol
    })) ?? [];

    // Ensure uniqueness based on networkSymbol
    const uniqueNetworks = Array.from(
      new Map(networks.map(n => [n.networkSymbol, n])).values()
    );

    res.json({ success: true, data: uniqueNetworks });
  });

  return router;
}

// Default export using the production service singleton.
export default createTyltRoutes();
