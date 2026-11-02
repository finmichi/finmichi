// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { dateSchema } from './transaction-schemas.js';
export type MarketSource = 'bot' | 'twse' | 'tpex' | 'calendar';
export interface FxRate {
  rate_date: string;
  currency: string;
  source: 'bot';
  spot_buy: string | null;
  spot_sell: string | null;
  cash_buy: string | null;
  cash_sell: string | null;
  method?: 'fetch' | 'upload';
}
export interface MarketPrice {
  trade_date: string;
  market: 'TWSE' | 'TPEx';
  symbol: string;
  close: string;
  source: 'twse' | 'tpex';
}
export interface MarketDay {
  date: string;
  market: 'TWSE';
  is_trading_day: boolean;
  source: 'twse';
}
export interface MarketQuote {
  rate: string;
  rate_date: string;
  source: 'bot' | 'bot-cross';
}
export interface MarketBatch {
  source: MarketSource;
  data_date: string | null;
  fx: FxRate[];
  prices: MarketPrice[];
  calendar: MarketDay[];
  row_count: number;
  skipped_no_price: number;
  skipped_no_rate: number;
  warning: boolean;
  filename?: string;
}
export const fxUploadSchema = z.strictObject({
  filename: z.string().min(1).max(255),
  content: z.string().min(1).max(1_000_000),
  rate_date: dateSchema.optional(),
});
export type FxUpload = z.infer<typeof fxUploadSchema>;
export interface FxUploadPreview {
  data_date: string;
  row_count: number;
  accepted: number;
  skipped_no_rate: number;
  rates: FxRate[];
  date_source: 'filename' | 'user';
}
export interface MarketRun {
  stale: boolean;
  estimated_days: boolean;
  source: MarketSource;
  status: string;
  method: string;
  data_date: string | null;
  received_date: string | null;
  error_code: string | null;
  last_finished_at: string | null;
  next_retry_at: string | null;
  skipped_no_price: number;
  skipped_no_rate: number;
}
export interface MarketPriceCoverage {
  source: 'twse' | 'tpex';
  data_date: string | null;
  tracked_securities: number;
  missing_prices: number;
}
export interface MarketDashboard {
  price_coverage: MarketPriceCoverage[];
  rates: FxRate[];
  runs: MarketRun[];
}
export class MarketDataError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface MarketFetchFailure {
  event: 'market.fetch';
  source: MarketSource;
  code: string;
  failure_count: number;
  next_retry_at: string | null;
}
