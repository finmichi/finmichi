// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  parseBot,
  parseTwseCsv,
  parsePrices,
  parseCalendar,
  botFilenameDate,
  responseFilename,
} from './market-parse.js';
import {
  findMarketRate,
  marketAge,
  marketValue,
  valueHoldings,
} from './market-math.js';
import {
  fetchMarket,
  assertMarketUrl,
  marketUrl,
  type MarketFetch,
} from './market-fetch.js';
import { marketSchedule } from './market-worker.js';
import type { FxRate, MarketPrice } from './market-schemas.js';
const fixture = (name: string) =>
  readFileSync(
    new URL('../test/fixtures/market/' + name, import.meta.url),
    'utf8',
  );
const csv = fixture('bot.csv'),
  filename = 'ExchangeRate@202610221600.csv';
const fx = (
  currency: string,
  date: string,
  buy: string | null,
  sell: string | null,
): FxRate => ({
  currency,
  rate_date: date,
  spot_buy: buy,
  spot_sell: sell,
  cash_buy: null,
  cash_sell: null,
  source: 'bot',
});
const response = (
  body: string,
  type = 'application/json',
  extra: Record<string, string> = {},
) => new Response(body, { headers: { 'content-type': type, ...extra } });
const mock = (
  body: string,
  type = 'application/json',
  headers: Record<string, string> = {},
) => vi.fn(async () => response(body, type, headers)) as unknown as MarketFetch;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('strict synthetic source contracts', () => {
  it('BOT BOM/21 columns/labels and all four cash/spot fields, source filename/date', () => {
    expect(
      readFileSync(new URL('../test/fixtures/market/bot.csv', import.meta.url))
        .subarray(0, 3)
        .toString('hex'),
    ).toBe('efbbbf');
    const b = parseBot(csv, filename);
    expect(b.data_date).toBe('2026-10-22');
    expect(b.fx).toHaveLength(2);
    expect(b.fx[0]).toMatchObject({
      currency: 'USD',
      cash_buy: '31.5000000000',
      spot_buy: '31.8000000000',
      cash_sell: '32.1000000000',
      spot_sell: '31.9000000000',
    });
    expect(responseFilename('attachment; filename="' + filename + '"')).toBe(
      filename,
    );
    expect(
      responseFilename(
        "attachment; filename*=UTF-8''ExchangeRate%40202610221600.csv",
      ),
    ).toBe(filename);
    expect(botFilenameDate(filename)).toBe('2026-10-22');
  });
  it('accepts only extra trailing blank fields in header and rows, keeping the original 21-field contract', () => {
    const expected = parseBot(csv, filename);
    expect(parseBot(fixture('bot-trailing-empty.csv'), filename)).toEqual(
      expected,
    );
    const lines = csv.trimEnd().split(/\r?\n/);
    expect(
      parseBot(lines.map((line) => line + ',  ,\t').join('\n'), filename),
    ).toEqual(expected);
    for (const index of [0, 1]) {
      const extra = [...lines];
      extra[index] += ',not-empty';
      expect(() => parseBot(extra.join('\n'), filename)).toThrow(
        'market_data_invalid',
      );
    }
    const short = [...lines];
    short[1] = short[1]!.split(',').slice(0, 20).join(',');
    expect(() => parseBot(short.join('\n'), filename)).toThrow(
      'market_data_invalid',
    );
  });
  it('zero means null, no rates skipped, one side remains usable', () => {
    const b = parseBot(csv.replace('31.80000', '0.00000'), filename);
    expect(b.fx[0]!.spot_buy).toBeNull();
    expect(findMarketRate(b.fx, 'USD', 'TWD', '2026-10-22')?.rate).toBe(
      '31.9000000000',
    );
    const a = csv.trim().split(/\r?\n/);
    const row = a[1]!.split(',');
    for (const i of [2, 3, 12, 13]) row[i] = '0.00000';
    a[1] = row.join(',');
    const zero = parseBot(a.join('\n'), filename);
    expect(zero.skipped_no_rate).toBe(1);
    expect(zero.fx).toHaveLength(1);
  });
  it.each(['本行買入', '本行賣出'])(
    'mismatched label %s rejects the batch',
    (label) => {
      expect(() => parseBot(csv.replace(label, '錯誤標籤'), filename)).toThrow(
        'market_data_invalid',
      );
    },
  );
  it('rejects bad columns/currency/decimal and missing date; manual date is explicit and filename wins', () => {
    for (const bad of [
      csv.replace('幣別,匯率', '幣別,變更'),
      csv.replace('USD,', 'ZZZ,'),
      csv.replace('31.80000', '1e5'),
      csv.replace('31.80000', '-1'),
      csv.replace('JPY,', 'JPY,extra,'),
    ])
      expect(() => parseBot(bad, filename)).toThrow('market_data_invalid');
    expect(() => parseBot(csv, 'manual.csv')).toThrow('source_date_missing');
    expect(parseBot(csv, 'manual.csv', '2026-10-20').data_date).toBe(
      '2026-10-20',
    );
    expect(parseBot(csv, filename, '2026-10-01').data_date).toBe('2026-10-22');
    expect(() => parseBot(csv, 'ExchangeRate@202602301200.csv')).toThrow(
      'market_data_invalid',
    );
  });
  it('TPEx required four strings, ROC conversion, trim and --- skip; extras are ignored', () => {
    const b = parsePrices('tpex', fixture('tpex.json'));
    expect(b.data_date).toBe('2026-10-22');
    expect(b.prices[0]).toMatchObject({
      symbol: '9999A',
      market: 'TPEx',
      close: '10.500000',
    });
    expect(b.skipped_no_price).toBe(1);
    expect(b.warning).toBe(false);
  });
  it('TWSE blank skips without substituting monthly average; warning requires more than half', () => {
    const rows = JSON.parse(fixture('twse.json'));
    const b = parsePrices('twse', JSON.stringify(rows));
    expect(b.prices).toHaveLength(1);
    expect(b.skipped_no_price).toBe(1);
    expect(b.warning).toBe(false);
    rows.push({ ...rows[1], Code: '00999B', ClosingPrice: '--' });
    expect(parsePrices('twse', JSON.stringify(rows)).warning).toBe(true);
  });
  it('mixed/missing dates, price formats, invalid symbols and conflicting duplicates reject whole batch', () => {
    const rows = JSON.parse(fixture('tpex.json'));
    for (const change of [
      { Date: '1151021' },
      { Close: 'not-money' },
      { SecuritiesCompanyCode: 'bad/host' },
      { Date: '1150230' },
    ])
      expect(() =>
        parsePrices(
          'tpex',
          JSON.stringify([rows[0], { ...rows[1], ...change }]),
        ),
      ).toThrow();
    const missing = { ...rows[0] };
    delete missing.Date;
    expect(() => parsePrices('tpex', JSON.stringify([missing]))).toThrow(
      'source_date_missing',
    );
    expect(() =>
      parsePrices(
        'tpex',
        JSON.stringify([rows[0], { ...rows[0], Close: '11.00' }]),
      ),
    ).toThrow('source_conflict');
    expect(
      parsePrices(
        'tpex',
        JSON.stringify([rows[0], { ...rows[0], Close: '10.500' }]),
      ).prices,
    ).toHaveLength(1);
  });
  it('calendar provides only observed years, distinguishes open markers and preserves holiday dates', () => {
    const b = parseCalendar(fixture('calendar.json'), [2026, 2027]);
    expect(b.calendar).toHaveLength(730);
    expect(
      b.calendar.find((d) => d.date === '2026-10-26')?.is_trading_day,
    ).toBe(false);
    expect(
      b.calendar.find((d) => d.date === '2027-01-04')?.is_trading_day,
    ).toBe(true);
    expect(b.warning).toBe(false);
    const partial = parseCalendar(
      JSON.stringify(JSON.parse(fixture('calendar.json')).slice(0, 1)),
      [2026, 2027],
    );
    expect(partial.calendar).toHaveLength(365);
    expect(partial.warning).toBe(true);
    expect(partial.calendar.some((d) => d.date.startsWith('2027'))).toBe(false);
  });
});
describe('allowlisted bounded network, no CI live traffic', () => {
  it('fixed URLs use exactly four HTTPS hosts, and all caller-supplied variations reject', () => {
    expect(
      new Set(
        ['bot', 'twse', 'tpex', 'calendar'].map(
          (s) => new URL(marketUrl(s as 'bot')).hostname,
        ),
      ).size,
    ).toBe(4);
    for (const u of [
      'http://rate.bot.com.tw/xrt/flcsv/0/day',
      'https://rate.bot.com.tw.evil/xrt/flcsv/0/day',
      'https://rate.bot.com.tw:444/xrt/flcsv/0/day',
      'https://user@rate.bot.com.tw/xrt/flcsv/0/day',
      'https://rate.bot.com.tw/xrt/flcsv/0/day?x=1',
      'file:///tmp/data',
      'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json',
      'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data&extra=1',
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL',
    ])
      expect(() => assertMarketUrl(u)).toThrow('source_not_allowed');
  });
  it('uses synthetic BOT response, source filename and no cookie/auth/redirect following', async () => {
    const client = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.credentials).toBe('omit');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(new Headers(init?.headers).has('cookie')).toBe(false);
      return response(csv, 'text/csv', {
        'content-disposition': 'attachment;filename="' + filename + '"',
      });
    }) as unknown as MarketFetch;
    expect(
      (await fetchMarket('bot', new Date('2026-10-22'), client)).fx,
    ).toEqual(parseBot(csv, filename).fx);
    await expect(
      fetchMarket('bot', new Date(), mock(csv, 'text/csv')),
    ).rejects.toMatchObject({ code: 'source_date_missing' });
  });
  it('automatic fetch accepts the same 22-field synthetic CSV as manual upload', async () => {
    expect(
      await fetchMarket(
        'bot',
        new Date(),
        mock(fixture('bot-trailing-empty.csv'), 'text/csv', {
          'content-disposition': 'attachment;filename="' + filename + '"',
        }),
      ),
    ).toEqual(parseBot(csv, filename));
  });
  it.each([
    ['ENOTFOUND', 'dns_failed'],
    ['EAI_AGAIN', 'dns_failed'],
    ['ECONNREFUSED', 'connection_refused'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'],
    ['CERT_HAS_EXPIRED', 'tls_failed'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_failed'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls_failed'],
    ['UNKNOWN', 'source_unavailable'],
    [undefined, 'source_unavailable'],
  ])(
    'classifies cause.code %s without retaining source details',
    async (code, expected) => {
      const client: MarketFetch = async () => {
        throw new Error('PRIVATE_RESPONSE ENOTFOUND', { cause: { code } });
      };
      await expect(
        fetchMarket('bot', new Date(), client),
      ).rejects.toMatchObject({ code: expected, message: expected });
    },
  );
  it('HTML challenge and redirect are blocked, never bypassed', async () => {
    const html = mock('<html>Challenge Validation</html>', 'text/html');
    await expect(fetchMarket('bot', new Date(), html)).rejects.toMatchObject({
      code: 'blocked_by_source',
    });
    expect(html).toHaveBeenCalledTimes(1);
    await expect(
      fetchMarket(
        'bot',
        new Date(),
        mock('<html>Challenge</html>', 'text/csv'),
      ),
    ).rejects.toMatchObject({ code: 'blocked_by_source' });
    const redirect = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.invalid/' },
        }),
    ) as unknown as MarketFetch;
    await expect(
      fetchMarket('tpex', new Date(), redirect),
    ).rejects.toMatchObject({ code: 'redirect_forbidden' });
    expect(redirect).toHaveBeenCalledTimes(1);
  });
  it('enforces advertised and streamed 8MiB bound', async () => {
    await expect(
      fetchMarket(
        'twse',
        new Date(),
        mock('[]', 'text/csv', {
          'content-length': String(8 * 1024 * 1024 + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: 'source_too_large' });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        c.close();
      },
    });
    await expect(
      fetchMarket(
        'twse',
        new Date(),
        vi.fn(
          async () =>
            new Response(stream, {
              headers: { 'content-type': 'text/csv' },
            }),
        ) as unknown as MarketFetch,
      ),
    ).rejects.toMatchObject({ code: 'source_too_large' });
  });
  it('aborts within 20 seconds and CI default live fetch is prohibited', async () => {
    vi.stubEnv('CI', 'true');
    await expect(fetchMarket('twse', new Date())).rejects.toMatchObject({
      code: 'ci_network_disabled',
    });
    vi.useFakeTimers();
    const client = vi.fn(
      async (_u: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    ) as unknown as MarketFetch;
    const check = expect(
      fetchMarket('twse', new Date(), client),
    ).rejects.toMatchObject({ code: 'source_timeout' });
    await vi.advanceTimersByTimeAsync(20_000);
    await check;
  });
});
describe('independent Decimal oracle and valuation', () => {
  const oracle = JSON.parse(fixture('oracle.json')) as {
    from: string;
    to: string;
    buy: string | null;
    sell: string | null;
    base_buy: string;
    base_sell: string;
    expected_rate: string;
    valuation_for_100: string;
  }[];
  it.each(oracle)(
    'cross $from/$to exact HALF_UP against independent Decimal',
    (o) => {
      const q = findMarketRate(
        [
          ...(o.from === 'TWD'
            ? []
            : [fx(o.from, '2026-10-22', o.buy, o.sell)]),
          fx(o.to, '2026-10-22', o.base_buy, o.base_sell),
        ],
        o.from,
        o.to,
        '2026-10-22',
      );
      expect(q?.rate).toBe(o.expected_rate);
      expect(q?.source).toBe('bot-cross');
      expect(marketValue('100', q!.rate)).toBe(o.valuation_for_100);
    },
  );
  it('uses latest COMMON date, never mismatched legs or future rates; missing leg is unavailable', () => {
    const rows = [
      fx('EUR', '2026-10-20', '35.5', '35.5'),
      fx('USD', '2026-10-20', '32.5', '32.5'),
      fx('USD', '2026-10-21', '32.75', '32.75'),
      fx('EUR', '2026-10-22', '36.5', '36.5'),
    ];
    expect(findMarketRate(rows, 'EUR', 'USD', '2026-10-22')).toEqual({
      rate: '1.0923076923',
      rate_date: '2026-10-20',
      source: 'bot-cross',
    });
    expect(findMarketRate(rows, 'EUR', 'USD', '2026-10-19')).toBeNull();
    expect(
      findMarketRate(
        rows.filter((r) => r.currency !== 'USD'),
        'EUR',
        'USD',
        '2026-10-22',
      ),
    ).toBeNull();
    expect(
      findMarketRate(
        [fx('USD', '2026-10-22', null, null)],
        'USD',
        'TWD',
        '2026-10-22',
      ),
    ).toBeNull();
  });
  it('rounds signed revaluation at half cents, including negative original balances', () => {
    expect(marketValue('1', '1.005')).toBe('1.01');
    expect(marketValue('-1', '1.005')).toBe('-1.01');
    expect(marketValue('100', '31.85')).toBe('3185.00');
  });
  it('stock pure function handles several positions, latest <=as_of and missing prices', () => {
    const prices: MarketPrice[] = [
      {
        symbol: '9999',
        market: 'TWSE',
        close: '10.123456',
        trade_date: '2026-10-20',
        source: 'twse',
      },
      {
        symbol: '9999',
        market: 'TWSE',
        close: '11',
        trade_date: '2026-10-22',
        source: 'twse',
      },
      {
        symbol: '9999A',
        market: 'TPEx',
        close: '2.675',
        trade_date: '2026-10-21',
        source: 'tpex',
      },
    ];
    const r = valueHoldings(
      [
        { symbol: '9999', market: 'TWSE', quantity: '100' },
        { symbol: '9999A', market: 'TPEx', quantity: '1' },
        { symbol: '99999', market: 'TPEx', quantity: '1' },
      ],
      prices,
      '2026-10-21',
    );
    expect(r.map((x) => x.market_amount)).toEqual(['1012.35', '2.68', null]);
    expect(r.map((x) => x.price_date)).toEqual([
      '2026-10-20',
      '2026-10-21',
      null,
    ]);
  });
  it('age uses known trading calendar, falls back only where missing, and FX always weekdays', () => {
    const calendar = parseCalendar(
      fixture('calendar.json'),
      [2026, 2027],
    ).calendar;
    expect(marketAge('2026-10-19', '2026-10-27', calendar)).toMatchObject({
      days: 4,
      stale: true,
      estimated: false,
    });
    expect(marketAge('2026-10-19', '2026-10-26', calendar)).toMatchObject({
      days: 4,
      stale: true,
      estimated: false,
    });
    expect(marketAge('2026-10-19', '2026-10-23', calendar)).toMatchObject({
      days: 3,
      stale: false,
    });
    expect(marketAge('2028-01-03', '2028-01-10', calendar)).toMatchObject({
      days: 4,
      stale: true,
      estimated: true,
    });
    expect(marketAge('2026-10-19', '2026-10-27', calendar, true)).toMatchObject(
      { days: 5, stale: true, estimated: true },
    );
  });
  it('Taipei schedule has exact 10:00/16:30, 15:00 and monthly key boundaries', () => {
    expect(
      marketSchedule(new Date('2026-10-22T01:59:00Z')).jobs.map(
        (x) => x.source,
      ),
    ).toEqual(['calendar']);
    expect(
      marketSchedule(new Date('2026-10-22T02:00:00Z')).jobs.find(
        (x) => x.source === 'bot',
      )?.key,
    ).toBe('2026-10-22:1000');
    expect(
      marketSchedule(new Date('2026-10-22T07:00:00Z')).jobs.map(
        (x) => x.source,
      ),
    ).toEqual(['calendar', 'bot', 'twse', 'tpex']);
    expect(
      marketSchedule(new Date('2026-10-22T08:30:00Z')).jobs.find(
        (x) => x.source === 'bot',
      )?.key,
    ).toBe('2026-10-22:1630');
    expect(
      marketSchedule(new Date('2026-10-24T08:30:00Z')).jobs.map(
        (x) => x.source,
      ),
    ).toEqual(['calendar']);
  });
});

describe('TWSE official open-data CSV (synthetic only)', () => {
  it('validates BOM/header/ROC date, quoted thousands and escaped names; skips missing prices', async () => {
    const csv = fixture('twse.csv')
      .replace('20.125000', '"1,234.50"')
      .replace('合成上市甲', '"合成,甲""乙"');
    const b = parseTwseCsv(csv);
    expect(b.data_date).toBe('2026-10-22');
    expect(b.prices).toHaveLength(1);
    expect(b.prices[0]!.close).toBe('1234.500000');
    expect(b.skipped_no_price).toBe(1);
    const client = mock(csv, 'text/csv; charset=utf-8');
    expect(await fetchMarket('twse', new Date(), client)).toEqual(b);
    expect(client).toHaveBeenCalledWith(
      'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data',
      expect.objectContaining({ redirect: 'manual', credentials: 'omit' }),
    );
    expect(parseTwseCsv(csv.replace(',--,0,0', ',,0,0')).skipped_no_price).toBe(
      1,
    );
  });
  it('rejects malformed structure, columns, dates, decimal grouping and conflicts, without inventing a date', () => {
    const csv = fixture('twse.csv');
    for (const bad of [
      csv.replace('收盤價', '其他價格'),
      csv.replace('合成上市甲,', '合成上市甲,extra,'),
      csv.replace('20.125000', '"12,34.50"'),
      csv.replace('20.125000', '-1'),
      csv.replace('20.125000', '1e2'),
      csv.replace('20.125000', '1.1234567'),
      csv.replace('1151022,00999A', '1151021,00999A'),
      csv.replaceAll('1151022', '1150230'),
      csv + csv.split('\n')[1]!.replace('20.125000', '21.00') + '\n',
    ])
      expect(() => parseTwseCsv(bad)).toThrow();
    expect(() => parseTwseCsv(csv.split('\n')[0]!)).toThrow(
      'source_date_missing',
    );
    expect(() => parseTwseCsv(csv.replace('1151022,9999', ',9999'))).toThrow(
      'source_date_missing',
    );
  });
  it.each(['text/html', 'text/csv'])(
    'blocks TWSE HTML/challenge with %s, with only one request',
    async (type) => {
      const client = mock('<html>Challenge Validation</html>', type);
      await expect(
        fetchMarket('twse', new Date(), client),
      ).rejects.toMatchObject({ code: 'blocked_by_source' });
      expect(client).toHaveBeenCalledTimes(1);
    },
  );
});
