// SPDX-License-Identifier: AGPL-3.0-only
import {
  MarketDataError,
  type MarketSource,
  type MarketBatch,
} from './market-schemas.js';
import {
  parseBot,
  parseTwseCsv,
  parsePrices,
  parseCalendar,
  responseFilename,
} from './market-parse.js';
export const marketHosts = [
  'rate.bot.com.tw',
  'openapi.twse.com.tw',
  'www.twse.com.tw',
  'www.tpex.org.tw',
] as const;
const urls = {
  bot: 'https://rate.bot.com.tw/xrt/flcsv/0/day',
  twse: 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data',
  tpex: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  calendar: 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule',
} as const;
export function marketUrl(source: MarketSource) {
  const u = urls[source];
  if (!u) throw new MarketDataError('source_not_allowed');
  return u;
}
export function assertMarketUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    !marketHosts.some((h) => h === u.hostname) ||
    !Object.values(urls).some((v) => v === u.href)
  )
    throw new MarketDataError('source_not_allowed');
}
// Classify only documented transport codes, never error messages or response text.
function transportErrorCode(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined;
  if (typeof code !== 'string') return 'source_unavailable';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME'].includes(code))
    return 'dns_failed';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    [
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_REVOKED',
      'INVALID_CA',
    ].includes(code)
  )
    return 'tls_failed';
  return 'source_unavailable';
}
export type MarketFetch = typeof globalThis.fetch;
export async function fetchMarket(
  source: MarketSource,
  now: Date,
  client: MarketFetch = globalThis.fetch,
): Promise<MarketBatch> {
  const url = marketUrl(source);
  assertMarketUrl(url);
  if (process.env.CI && client === globalThis.fetch)
    throw new MarketDataError('ci_network_disabled');
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 20_000),
    limit = 8 * 1024 * 1024;
  try {
    const r = await client(url, {
      signal: abort.signal,
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        accept:
          source === 'bot' || source === 'twse'
            ? 'text/csv'
            : 'application/json',
        'user-agent': 'finmichi-market-cache/0.0.1',
      },
    });
    const type = (r.headers.get('content-type') ?? '').toLowerCase();
    if (
      (source === 'bot' || source === 'twse') &&
      ((r.status >= 300 && r.status < 400) || !type.startsWith('text/csv'))
    ) {
      await r.body?.cancel();
      throw new MarketDataError('blocked_by_source');
    }
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      throw new MarketDataError('redirect_forbidden');
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new MarketDataError('source_http_error');
    }
    if (
      source !== 'bot' &&
      source !== 'twse' &&
      !type.startsWith('application/json')
    ) {
      await r.body?.cancel();
      throw new MarketDataError('market_data_invalid');
    }
    if (Number(r.headers.get('content-length') ?? 0) > limit) {
      await r.body?.cancel();
      throw new MarketDataError('source_too_large');
    }
    const reader = r.body?.getReader();
    if (!reader) throw new MarketDataError('market_data_invalid');
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new MarketDataError('source_too_large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const p of chunks) {
      bytes.set(p, offset);
      offset += p.length;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (source === 'bot' || source === 'twse') {
      if (text.trimStart().startsWith('<'))
        throw new MarketDataError('blocked_by_source');
      if (source === 'twse') return parseTwseCsv(text);
      return parseBot(
        text,
        responseFilename(r.headers.get('content-disposition') ?? ''),
      );
    }
    if (source === 'calendar') {
      const year = Number(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Taipei',
          year: 'numeric',
        }).format(now),
      );
      return parseCalendar(text, [year, year + 1]);
    }
    return parsePrices(source, text);
  } catch (e) {
    if (e instanceof MarketDataError) throw e;
    throw new MarketDataError(
      abort.signal.aborted ? 'source_timeout' : transportErrorCode(e),
    );
  } finally {
    clearTimeout(timer);
  }
}
