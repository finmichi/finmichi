// SPDX-License-Identifier: AGPL-3.0-only
import { parse } from 'csv-parse/sync';
import { dateSchema } from './transaction-schemas.js';
import {
  MarketDataError,
  type MarketBatch,
  type MarketSource,
  type MarketPrice,
  type FxRate,
} from './market-schemas.js';
import {
  decimalUnits,
  marketFixed,
  marketDayAfter,
  isWeekday,
} from './market-math.js';
const bad = () => new MarketDataError('market_data_invalid');
const empty = (source: MarketSource): MarketBatch => ({
  source,
  data_date: null,
  fx: [],
  prices: [],
  calendar: [],
  row_count: 0,
  skipped_no_price: 0,
  skipped_no_rate: 0,
  warning: false,
});
function text(row: Record<string, unknown>, key: string) {
  if (typeof row[key] !== 'string')
    throw key === 'Date' ? new MarketDataError('source_date_missing') : bad();
  return row[key].trim();
}
export function rocDate(v: string) {
  if (!/^\d{7}$/.test(v)) throw new MarketDataError('source_date_missing');
  const day =
    String(Number(v.slice(0, 3)) + 1911).padStart(4, '0') +
    '-' +
    v.slice(3, 5) +
    '-' +
    v.slice(5);
  if (!dateSchema.safeParse(day).success) throw bad();
  return day;
}
function jsonRows(v: string) {
  let a: unknown;
  try {
    a = JSON.parse(v);
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(a) ||
    a.some((x) => !x || typeof x !== 'object' || Array.isArray(x))
  )
    throw bad();
  return a as Record<string, unknown>[];
}
export function parsePrices(
  source: 'twse' | 'tpex',
  content: string,
): MarketBatch {
  const b = empty(source),
    rows = jsonRows(content),
    unique = new Map<string, MarketPrice>();
  b.row_count = rows.length;
  for (const row of rows) {
    const day = rocDate(text(row, 'Date')),
      symbol = text(row, source === 'twse' ? 'Code' : 'SecuritiesCompanyCode'),
      name = text(row, source === 'twse' ? 'Name' : 'CompanyName'),
      price = text(row, source === 'twse' ? 'ClosingPrice' : 'Close');
    if (!/^[A-Z0-9]{4,6}$/.test(symbol) || !name || name.length > 256)
      throw bad();
    if (b.data_date !== null && b.data_date !== day) throw bad();
    b.data_date = day;
    if (price === '' || /^--+$/.test(price)) {
      b.skipped_no_price++;
      continue;
    }
    if (!/^\d{1,14}(?:\.\d{1,6})?$/.test(price)) throw bad();
    const canonical = marketFixed(decimalUnits(price, 6), 6),
      old = unique.get(symbol);
    if (old && old.close !== canonical)
      throw new MarketDataError('source_conflict');
    unique.set(symbol, {
      symbol,
      trade_date: day,
      market: source === 'twse' ? 'TWSE' : 'TPEx',
      close: canonical,
      source,
    });
  }
  b.prices = [...unique.values()];
  b.warning = b.skipped_no_price * 2 > b.row_count;
  return b;
}
export const twseHeader =
  '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數';
export function parseTwseCsv(content: string): MarketBatch {
  let rows: string[][];
  try {
    rows = parse(content, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 4096,
    }) as string[][];
  } catch {
    throw bad();
  }
  if (!rows[0] || rows[0].join(',') !== twseHeader) throw bad();
  if (rows.length < 2) throw new MarketDataError('source_date_missing');
  const prices = rows.slice(1).map((r) => {
    if (r.length !== 11) throw bad();
    const close = r[8]!.trim();
    if (
      close &&
      !/^--+$/.test(close) &&
      !/^(?:\d{1,14}|\d{1,3}(?:,\d{3}){1,4})(?:\.\d{1,6})?$/.test(close)
    )
      throw bad();
    return {
      Date: r[0],
      Code: r[1],
      Name: r[2],
      ClosingPrice: close.replaceAll(',', ''),
    };
  });
  return parsePrices('twse', JSON.stringify(prices));
}
export const botHeader =
  '幣別,匯率,現金,即期,遠期10天,遠期30天,遠期60天,遠期90天,遠期120天,遠期150天,遠期180天,匯率,現金,即期,遠期10天,遠期30天,遠期60天,遠期90天,遠期120天,遠期150天,遠期180天';
export function botFilenameDate(name: string): string | null {
  const m = /^ExchangeRate@(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\.csv$/i.exec(
    name,
  );
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  if (
    !dateSchema.safeParse(d).success ||
    Number(m[4]) > 23 ||
    Number(m[5]) > 59
  )
    throw bad();
  return d;
}
export function responseFilename(disposition: string) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]!.trim());
    } catch {
      throw bad();
    }
  }
  return (
    /filename\s*=\s*"([^"]+)"/i.exec(disposition)?.[1] ??
    /filename\s*=\s*([^;\s]+)/i.exec(disposition)?.[1] ??
    ''
  );
}
export function parseBot(
  content: string,
  filename: string,
  userDate?: string,
): MarketBatch {
  const b = empty('bot'),
    day = botFilenameDate(filename) ?? userDate;
  if (!day) throw new MarketDataError('source_date_missing');
  if (!dateSchema.safeParse(day).success) throw bad();
  let rows: string[][];
  try {
    rows = parse(content, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 4096,
      relax_column_count: true,
    }) as string[][];
  } catch {
    throw bad();
  }
  // BOT may append empty columns to either the header or data rows.
  // Never truncate meaningful data or remove empty fields inside the 21-column contract.
  rows = rows.map((row) => {
    if (row.length < 21 || row.slice(21).some((value) => value.trim() !== ''))
      throw bad();
    return row.slice(0, 21);
  });
  if (!rows[0] || rows[0].join(',') !== botHeader) throw bad();
  b.data_date = day;
  if (botFilenameDate(filename)) b.filename = filename;
  const currencies = new Set(Intl.supportedValuesOf('currency')),
    unique = new Map<string, FxRate>();
  for (const r of rows.slice(1)) {
    b.row_count++;
    if (
      r.length !== 21 ||
      r[1]?.trim() !== '本行買入' ||
      r[11]?.trim() !== '本行賣出'
    )
      throw bad();
    const currency = r[0]!.trim();
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !currencies.has(currency) ||
      currency === 'TWD'
    )
      throw bad();
    const value = (i: number) => {
      const s = r[i]!.trim();
      if (s === '' || /^--+$/.test(s)) return null;
      if (!/^\d{1,14}(?:\.\d{1,10})?$/.test(s)) throw bad();
      const n = decimalUnits(s, 10);
      return n === 0n ? null : marketFixed(n, 10);
    };
    const row: FxRate = {
      currency,
      rate_date: day,
      source: 'bot',
      cash_buy: value(2),
      spot_buy: value(3),
      cash_sell: value(12),
      spot_sell: value(13),
    };
    if (
      row.spot_buy === null &&
      row.spot_sell === null &&
      row.cash_buy === null &&
      row.cash_sell === null
    ) {
      b.skipped_no_rate++;
      continue;
    }
    const old = unique.get(currency);
    if (old && JSON.stringify(old) !== JSON.stringify(row))
      throw new MarketDataError('source_conflict');
    unique.set(currency, row);
  }
  b.fx = [...unique.values()];
  return b;
}
export function parseCalendar(
  content: string,
  years: readonly number[],
): MarketBatch {
  const b = empty('calendar'),
    rows = jsonRows(content),
    special = new Map<string, boolean>(),
    found = new Set<number>();
  b.row_count = rows.length;
  for (const row of rows) {
    const day = rocDate(text(row, 'Date')),
      name = text(row, 'Name');
    text(row, 'Description');
    text(row, 'Weekday');
    if (!name || name.length > 256) throw bad();
    const year = Number(day.slice(0, 4));
    if (!years.includes(year)) continue;
    const open = name.includes('開始交易') || name.includes('最後交易');
    if (special.has(day) && special.get(day) !== open)
      throw new MarketDataError('source_conflict');
    special.set(day, open);
    found.add(year);
    if (b.data_date === null || day > b.data_date) b.data_date = day;
  }
  for (const year of found)
    for (
      let day = `${year}-01-01`;
      day <= `${year}-12-31`;
      day = marketDayAfter(day)
    )
      b.calendar.push({
        date: day,
        market: 'TWSE',
        is_trading_day: special.get(day) ?? isWeekday(day),
        source: 'twse',
      });
  b.warning = years.some((y) => !found.has(y));
  return b;
}
