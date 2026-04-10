/**
 * ITyltCurrencyService
 *
 * SOLID:
 *  - Interface Segregation (ISP): Only the four lookup methods the payment routes
 *    need. Caching, HTTP, and signing details remain private to the concrete class.
 *  - Dependency Inversion (DIP): Routes depend on this abstraction, not the concrete
 *    TyltCurrencyService, making routes trivially testable with a mock.
 */

// ─── Response shapes (mirror the Tylt API exactly) ───────────────────────────

export interface TyltNetworkInfo {
  standard:           string;
  canDeposit:         number;
  canWithdraw:        number;
  networkFees:        number;
  networkName:        string;
  networkSymbol:      string;
  maximumDeposit:     number;
  minimumDeposit:     number;
  contractAddress:    string;
  maximumWithdrawal:  number;
  minimumWithdrawal:  number;
}

export interface TyltCryptoCurrency {
  currencyName:   string;
  currencySymbol: string;
  networks:       TyltNetworkInfo[];
}

export interface TyltFiatCurrency {
  currencyName:   string;
  currencySymbol: string;
}

export interface TyltCryptoNetwork {
  networkName:   string;
  networkSymbol: string;
}

export interface TyltBaseCurrency {
  currencyName:   string;
  currencySymbol: string;
  currencyType:   'CRYPTO' | 'FIAT' | string;
}

// ─── Service contract ─────────────────────────────────────────────────────────

export interface ITyltCurrencyService {
  /**
   * Returns supported crypto currencies with their available networks.
   * Used to populate the settledCurrency + networkSymbol dropdowns.
   */
  getCryptoCurrencies(): Promise<TyltCryptoCurrency[]>;

  /**
   * Returns supported fiat currencies.
   * Used to populate the baseCurrency dropdown when the source is fiat.
   */
  getFiatCurrencies(): Promise<TyltFiatCurrency[]>;

  /**
   * Returns supported blockchain networks.
   * Provides a flat network list for quick lookups / UI filters.
   */
  getCryptoNetworks(): Promise<TyltCryptoNetwork[]>;

  /**
   * Returns supported base currencies (both CRYPTO and FIAT).
   * Used to populate the baseCurrency dropdown for Pay-In requests.
   */
  getBaseCurrencies(): Promise<TyltBaseCurrency[]>;
}
