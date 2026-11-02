// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture } from '../test/catalog-fixture.js';
import {
  applyMarketBatch,
  marketService,
  runMarketWorker,
  parsePrices,
  parseTwseCsv,
  securityService,
  parseBot,
  transactionService,
  itemService,
  ledgerService,
  reportService,
  backupService,
  patService,
} from '@finmichi/core';
import type {
  MarketFetch,
  FxRate,
  MarketBatch,
  MarketFetchFailure,
} from '@finmichi/core';
const fixtureText = (file: string) =>
  readFileSync(
    new URL(
      '../../../packages/core/test/fixtures/market/' + file,
      import.meta.url,
    ),
    'utf8',
  );
const csv = fixtureText('bot.csv'),
  filename = 'ExchangeRate@202610221600.csv',
  now = new Date('2026-10-22T07:10:00Z');
let f: Awaited<ReturnType<typeof fixture>>;
const path = () => `/api/ledgers/${f.ledger}/market`;
async function clear() {
  await f.db`DELETE FROM market_fx_rates`;
  await f.db`DELETE FROM market_prices`;
  await f.db`DELETE FROM market_calendar`;
  await f.db`DELETE FROM market_fetch_runs`;
}
beforeAll(async () => {
  f = await fixture('market-' + randomUUID());
});
beforeEach(clear);
afterEach(clear);
afterAll(async () => {
  if (f) await f.close();
});
const upload = (extra: Record<string, unknown> = {}) => ({
  filename,
  content: csv,
  ...extra,
});
function clientFor(
  overrides: Partial<Record<'bot' | 'twse' | 'tpex' | 'calendar', string>> = {},
) {
  const calls: string[] = [];
  const client: MarketFetch = async (input, init) => {
    const u = String(input);
    calls.push(u);
    expect(init?.redirect).toBe('manual');
    const source = u.includes('rate.bot')
      ? 'bot'
      : u.includes('holidaySchedule')
        ? 'calendar'
        : u.includes('twse')
          ? 'twse'
          : 'tpex';
    const body =
      overrides[source] ??
      fixtureText(
        source === 'bot' || source === 'twse'
          ? source + '.csv'
          : source + '.json',
      );
    return new Response(body, {
      headers: {
        'content-type':
          source === 'bot' || source === 'twse'
            ? 'text/csv'
            : 'application/json',
        ...(source === 'bot'
          ? { 'content-disposition': 'attachment;filename="' + filename + '"' }
          : {}),
      },
    });
  };
  return { client, calls };
}
async function calendarDone() {
  await f.db`INSERT INTO market_fetch_runs(source,status,scheduled_key) VALUES ('calendar','success','2026-10')`;
}
it('manual preview has no writes; upload equals automatic parsed values, explicit date and safe audit', async () => {
  const service = marketService(f.db),
    before = (
      await f.db`SELECT count(*) n FROM audit_logs WHERE user_id=${f.actor}`
    )[0]!.n;
  const p = await f.app.inject({
    method: 'POST',
    url: path() + '/fx-preview',
    headers: f.headers,
    payload: upload(),
  });
  expect(p.statusCode).toBe(200);
  expect(p.json()).toMatchObject({
    data_date: '2026-10-22',
    accepted: 2,
    date_source: 'filename',
  });
  expect(await f.db`SELECT * FROM market_fx_rates`).toHaveLength(0);
  expect(
    (await f.db`SELECT count(*) n FROM audit_logs WHERE user_id=${f.actor}`)[0]!
      .n,
  ).toBe(before);
  const r = await f.app.inject({
    method: 'POST',
    url: path() + '/fx-upload',
    headers: f.headers,
    payload: upload(),
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ accepted: 2, method: 'upload' });
  const rows = await f.db<
    FxRate[]
  >`SELECT rate_date::text,currency,source,spot_buy::text,spot_sell::text,cash_buy::text,cash_sell::text FROM market_fx_rates ORDER BY currency`;
  expect(rows).toEqual(
    parseBot(csv, filename).fx.sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
  );
  const [meta] =
    await f.db`SELECT method,source_filename,first_success_filename FROM market_fetch_runs WHERE source='bot'`;
  expect(meta).toMatchObject({
    method: 'upload',
    source_filename: filename,
    first_success_filename: null,
  });
  const audit =
    await f.db`SELECT row_to_json(a)::text body FROM audit_logs a WHERE user_id=${f.actor} AND action='market.fx_upload'`;
  expect(audit).toHaveLength(1);
  for (const a of audit) {
    expect(String(a.body)).not.toContain(filename);
    expect(String(a.body)).not.toContain('31.80000');
    expect(String(a.body)).not.toMatch(
      /"(?:payload|content|filename|amount|rate)"/,
    );
  }
  const missing = await f.app.inject({
    method: 'POST',
    url: path() + '/fx-preview',
    headers: f.headers,
    payload: upload({ filename: 'manual.csv' }),
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json().error).toBe('source_date_missing');
  const explicit = await service.previewUpload(
    f.actor,
    f.ledger,
    upload({ filename: 'manual.csv', rate_date: '2026-10-21' }),
  );
  expect(explicit.data_date).toBe('2026-10-21');
  expect(explicit.date_source).toBe('user');
});
it('22-field synthetic CSV manual preview and upload match the 21-field source; nonempty extras fail without writes', async () => {
  const content = fixtureText('bot-trailing-empty.csv');
  for (const suffix of ['/fx-preview', '/fx-upload']) {
    const response = await f.app.inject({
      method: 'POST',
      url: path() + suffix,
      headers: f.headers,
      payload: upload({ content }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(2);
  }
  const before = JSON.stringify(
    await f.db`SELECT * FROM market_fx_rates ORDER BY currency`,
  );
  const response = await f.app.inject({
    method: 'POST',
    url: path() + '/fx-upload',
    headers: f.headers,
    payload: upload({ content: content.replace('USD,', 'USD,unexpected,') }),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe('market_data_invalid');
  expect(
    JSON.stringify(await f.db`SELECT * FROM market_fx_rates ORDER BY currency`),
  ).toBe(before);
});
it('each failed fetch reports one safe JSON event, exposes retry time in read-only dashboard, and respects backoff', async () => {
  await calendarDone();
  const morning = new Date('2026-10-22T02:00:00Z');
  const events: MarketFetchFailure[] = [];
  const record = (event: MarketFetchFailure) => {
    events.push(JSON.parse(JSON.stringify(event)));
  };
  const client: MarketFetch = async () => {
    throw new Error('PRIVATE_RESPONSE', { cause: { code: 'ENOTFOUND' } });
  };
  await runMarketWorker(f.db, morning, client, record);
  await runMarketWorker(
    f.db,
    new Date(morning.getTime() + 60000),
    client,
    record,
  );
  expect(events).toEqual([
    {
      event: 'market.fetch',
      source: 'bot',
      code: 'dns_failed',
      failure_count: 1,
      next_retry_at: '2026-10-22T02:05:00.000Z',
    },
  ]);
  const before = JSON.stringify(
    await f.db`SELECT * FROM market_fetch_runs ORDER BY source`,
  );
  const response = await f.app.inject({
    method: 'GET',
    url: path(),
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  const bot = response
    .json()
    .runs.find((r: { source: string }) => r.source === 'bot');
  expect(bot.error_code).toBe('dns_failed');
  expect(new Date(bot.next_retry_at).toISOString()).toBe(
    events[0]!.next_retry_at,
  );
  expect(
    JSON.stringify(await f.db`SELECT * FROM market_fetch_runs ORDER BY source`),
  ).toBe(before);
  await runMarketWorker(
    f.db,
    new Date(morning.getTime() + 300000),
    client,
    record,
  );
  expect(events[1]).toMatchObject({
    failure_count: 2,
    next_retry_at: '2026-10-22T02:15:00.000Z',
  });
  expect(JSON.stringify(events)).not.toContain('PRIVATE_RESPONSE');
  await f.db`DELETE FROM market_fetch_runs WHERE source='bot'`;
  events.length = 0;
  const blocked: MarketFetch = async () =>
    new Response('<html>PRIVATE_CHALLENGE</html>', {
      headers: { 'content-type': 'text/html' },
    });
  await runMarketWorker(f.db, morning, blocked, record);
  await runMarketWorker(
    f.db,
    new Date(morning.getTime() + 1800000),
    blocked,
    record,
  );
  await runMarketWorker(
    f.db,
    new Date(morning.getTime() + 3600000),
    blocked,
    record,
  );
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    code: 'blocked_by_source',
    next_retry_at: '2026-10-22T02:30:00.000Z',
  });
  expect(events[1]).toMatchObject({
    code: 'blocked_by_source',
    next_retry_at: null,
  });
  expect(JSON.stringify(events)).not.toContain('PRIVATE_CHALLENGE');
});
it('cookie/Origin/owner isolation and size/unknown-field validation; PAT cannot upload', async () => {
  const token = (
    await patService(f.db).create(f.actor, {
      expires_in_days: 1,
      scope: 'draft',
      ledger_ids: null,
      mask_text: true,
    })
  ).token;
  for (const suffix of ['', '/fx-preview', '/fx-upload']) {
    const method = suffix ? 'POST' : 'GET';
    expect(
      (
        await f.app.inject({
          method,
          url: path() + suffix,
          headers: {
            ...f.headers,
            authorization: 'Bearer ' + token,
            cookie: '',
          },
          ...(suffix ? { payload: upload() } : {}),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method,
          url: path() + suffix + (suffix ? '' : '?unknown=1'),
          headers: f.otherHeaders,
          ...(suffix ? { payload: upload({ unknown: true }) } : {}),
        })
      ).statusCode,
    ).toBe(404);
  }
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path() + '/fx-upload',
        headers: { ...f.headers, origin: 'https://evil.synthetic.invalid' },
        payload: upload(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path() + '/fx-upload',
        headers: f.headers,
        payload: upload({ unknown: 'PRIVATE_CSV' }),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path() + '/fx-preview',
        headers: f.headers,
        payload: upload({ content: 'x'.repeat(1_000_001) }),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await f.app.inject({ url: path() + '?unknown=1', headers: f.headers }))
      .statusCode,
  ).toBe(400);
  expect(await f.db`SELECT * FROM market_fx_rates`).toHaveLength(0);
});
it('whole source parsing rejects invalid rows without accepting the good prefix', async () => {
  await calendarDone();
  const bad = fixtureText('twse.csv').replace(
    '20.125000',
    'PRIVATE_NOT_A_PRICE',
  );
  const { client } = clientFor({ twse: bad });
  await runMarketWorker(f.db, now, client);
  expect(
    await f.db`SELECT * FROM market_prices WHERE source='twse'`,
  ).toHaveLength(0);
  const [r] =
    await f.db`SELECT status,error_code FROM market_fetch_runs WHERE source='twse'`;
  expect(r).toMatchObject({
    status: 'error',
    error_code: 'market_data_invalid',
  });
  expect(
    JSON.stringify(await f.db`SELECT * FROM market_fetch_runs`),
  ).not.toContain('PRIVATE_NOT_A_PRICE');
});
it('older dates do not overwrite newer values or fetched_at, same-day corrections can update', async () => {
  const original = parsePrices('twse', fixtureText('twse.json'));
  await f.db.begin((sql) => applyMarketBatch(sql, original, now));
  const before = await f.db`SELECT * FROM market_prices WHERE source='twse'`;
  const older = parsePrices(
    'twse',
    fixtureText('twse.json')
      .replaceAll('1151022', '1151021')
      .replace('20.125000', '999.000000'),
  );
  const r = await f.db.begin((sql) =>
    applyMarketBatch(sql, older, new Date(now.getTime() + 1000)),
  );
  expect(r.accepted).toBe(0);
  expect(await f.db`SELECT * FROM market_prices WHERE source='twse'`).toEqual(
    before,
  );
  const [meta] =
    await f.db`SELECT data_date::text,received_date::text FROM market_fetch_runs WHERE source='twse'`;
  expect(meta).toMatchObject({
    data_date: '2026-10-22',
    received_date: '2026-10-21',
  });
  const same = parsePrices(
    'twse',
    fixtureText('twse.json').replace('20.125000', '21.000000'),
  );
  await f.db.begin((sql) =>
    applyMarketBatch(sql, same, new Date(now.getTime() + 2000)),
  );
  expect(
    (await f.db`SELECT close::text FROM market_prices WHERE symbol='9999'`)[0]!
      .close,
  ).toBe('21.000000');
  const fx = marketService(f.db);
  await fx.upload(f.actor, f.ledger, upload(), now);
  const fxBefore = await f.db`SELECT * FROM market_fx_rates`;
  await fx.upload(
    f.actor,
    f.ledger,
    upload({ filename: 'manual.csv', rate_date: '2026-10-21' }),
    new Date(now.getTime() + 3000),
  );
  expect(await f.db`SELECT * FROM market_fx_rates`).toEqual(fxBefore);
});
it('legal missing prices retain prior quote; majority-missing batch is warning, not fatal', async () => {
  const before = parsePrices(
    'twse',
    fixtureText('twse.json')
      .replaceAll('1151022', '1151021')
      .replace('"ClosingPrice": ""', '"ClosingPrice": "12.000000"'),
  );
  await f.db.begin((sql) => applyMarketBatch(sql, before, now));
  const rows = JSON.parse(fixtureText('twse.json'));
  rows.push({ ...rows[1], Code: '00999B', ClosingPrice: '--' });
  const b = parsePrices('twse', JSON.stringify(rows));
  await f.db.begin((sql) => applyMarketBatch(sql, b, now));
  const [old] =
    await f.db`SELECT trade_date::text,close::text FROM market_prices WHERE symbol='00999A'`;
  expect(old).toMatchObject({ trade_date: '2026-10-21', close: '12.000000' });
  expect(
    (
      await f.db`SELECT status,skipped_no_price FROM market_fetch_runs WHERE source='twse'`
    )[0],
  ).toMatchObject({ status: 'warning', skipped_no_price: 2 });
});
it('cache writes are atomic across bulk chunks, without disabling constraints/triggers', async () => {
  const b: MarketBatch = {
    ...parsePrices('twse', fixtureText('twse.json')),
    prices: Array.from({ length: 600 }, (_, i) => ({
      symbol: String(i).padStart(4, '0'),
      trade_date: '2026-10-22',
      market: 'TWSE' as const,
      source: 'twse' as const,
      close: '1.000000',
    })),
  };
  await f.db.unsafe(
    `CREATE FUNCTION market_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.symbol='0555' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER market_test_failure BEFORE INSERT ON market_prices FOR EACH ROW EXECUTE FUNCTION market_test_failure()`,
  );
  try {
    await expect(
      f.db.begin((sql) => applyMarketBatch(sql, b, now)),
    ).rejects.toThrow('synthetic rollback');
    expect(await f.db`SELECT * FROM market_prices`).toHaveLength(0);
    expect(await f.db`SELECT * FROM market_fetch_runs`).toHaveLength(0);
  } finally {
    await f.db.unsafe(
      'DROP TRIGGER market_test_failure ON market_prices; DROP FUNCTION market_test_failure()',
    );
  }
});
it('concurrent workers claim each slot once and calendar covers only published years', async () => {
  const { client, calls } = clientFor();
  await Promise.all([
    runMarketWorker(f.db, now, client),
    runMarketWorker(f.db, now, client),
  ]);
  expect(calls).toHaveLength(4);
  expect(new Set(calls).size).toBe(4);
  expect(await f.db`SELECT * FROM market_calendar`).toHaveLength(730);
  expect(
    (
      await f.db`SELECT is_trading_day FROM market_calendar WHERE date='2026-10-26'`
    )[0]!.is_trading_day,
  ).toBe(false);
  await runMarketWorker(f.db, new Date(now.getTime() + 60000), client);
  expect(calls).toHaveLength(4);
  const [bot] =
    await f.db`SELECT first_success_filename FROM market_fetch_runs WHERE source='bot'`;
  expect(bot!.first_success_filename).toBe(filename);
});
it('holidays skip both price sources without error or network request', async () => {
  await calendarDone();
  await f.db`INSERT INTO market_calendar(date,market,is_trading_day,source) VALUES ('2026-10-22','TWSE',false,'twse')`;
  const { client, calls } = clientFor();
  const r = await runMarketWorker(f.db, now, client);
  expect(r.errors).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('rate.bot.com.tw');
  const states =
    await f.db`SELECT status,failure_count FROM market_fetch_runs WHERE source IN ('twse','tpex')`;
  expect(states).toHaveLength(2);
  expect(
    states.every(
      (x) => x.status === 'skipped_holiday' && x.failure_count === 0,
    ),
  ).toBe(true);
});
it('source errors back off; BOT blocked attempts are bounded at two per Taipei day', async () => {
  await calendarDone();
  let calls = 0;
  const failed: MarketFetch = async () => {
    calls++;
    throw new Error('DO_NOT_STORE_RAW_RESPONSE');
  };
  const morning = new Date('2026-10-22T02:00:00Z');
  await runMarketWorker(f.db, morning, failed);
  await runMarketWorker(f.db, new Date(morning.getTime() + 60000), failed);
  expect(calls).toBe(1);
  expect(
    (
      await f.db`SELECT failure_count,error_code FROM market_fetch_runs WHERE source='bot'`
    )[0],
  ).toMatchObject({ failure_count: 1, error_code: 'source_unavailable' });
  await runMarketWorker(f.db, new Date(morning.getTime() + 300000), failed);
  expect(calls).toBe(2);
  expect(
    (
      await f.db`SELECT failure_count FROM market_fetch_runs WHERE source='bot'`
    )[0]!.failure_count,
  ).toBe(2);
  await f.db`DELETE FROM market_fetch_runs WHERE source='bot'`;
  calls = 0;
  const blocked: MarketFetch = async () => {
    calls++;
    return new Response('<html>Challenge Validation</html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  await runMarketWorker(f.db, morning, blocked);
  await runMarketWorker(f.db, new Date(morning.getTime() + 60000), blocked);
  expect(calls).toBe(1);
  await runMarketWorker(f.db, new Date(morning.getTime() + 1800000), blocked);
  expect(calls).toBe(2);
  await f.db`INSERT INTO market_fetch_runs(source,status,scheduled_key) VALUES ('twse','success','2026-10-22'),('tpex','success','2026-10-22')`;
  await runMarketWorker(f.db, new Date('2026-10-22T08:30:00Z'), blocked);
  expect(calls).toBe(2);
  const [r] =
    await f.db`SELECT blocked_attempts,status,failure_count FROM market_fetch_runs WHERE source='bot'`;
  expect(r).toMatchObject({
    blocked_attempts: 2,
    status: 'blocked_by_source',
    failure_count: 0,
  });
  await runMarketWorker(f.db, new Date('2026-10-23T02:00:00Z'), blocked);
  expect(calls).toBe(3);
  expect(
    JSON.stringify(await f.db`SELECT * FROM market_fetch_runs`),
  ).not.toContain('DO_NOT_STORE_RAW_RESPONSE');
});
it('old or absent published prices are normal no-new-data and do not masquerade as today', async () => {
  await calendarDone();
  const { client } = clientFor({
    twse: fixtureText('twse.csv').replaceAll('1151022', '1151021'),
    tpex: '[]',
  });
  const result = await runMarketWorker(f.db, now, client);
  expect(result.errors).toBe(0);
  expect(
    (
      await f.db`SELECT max(trade_date)::text AS latest_date FROM market_prices WHERE source='twse'`
    )[0]!.latest_date,
  ).toBe('2026-10-21');
  const [r] =
    await f.db`SELECT status,failure_count,next_retry_at FROM market_fetch_runs WHERE source='tpex'`;
  expect(r).toMatchObject({ status: 'no_new_data', failure_count: 0 });
  expect(r!.next_retry_at).not.toBeNull();
});
it('reference priority user -> dated ledger -> market, metadata is accurate in HTTP preview and stored result', async () => {
  await marketService(f.db).upload(f.actor, f.ledger, upload(), now);
  const items = itemService(f.db),
    usd = await items.create(f.actor, f.ledger, {
      name: '合成參考USD',
      kind: 'asset',
      currency: 'USD',
    }),
    cash = await items.create(f.actor, f.ledger, {
      name: '合成參考TWD',
      kind: 'asset',
      currency: 'TWD',
    });
  const body = {
    occurred_on: '2026-10-22',
    entries: [
      { item_id: usd.id, amount: '-100' },
      { item_id: cash.id, amount: '4000' },
    ],
  };
  const preview = async (payload: unknown) => {
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/ledgers/${f.ledger}/transactions/preview`,
      headers: f.headers,
      payload,
    });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  expect((await preview(body)).fx_comparisons[0]).toMatchObject({
    reference_source: 'bot',
    reference_rate: '31.8500000000',
    reference_date: '2026-10-22',
    effective_rate: '40.0000000000',
  });
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${f.ledger},'2026-10-22','USD','TWD','33')`;
  expect((await preview(body)).fx_comparisons[0]).toMatchObject({
    reference_source: 'exchange_rates',
    reference_rate: '33.0000000000',
  });
  expect(
    (
      await preview({
        ...body,
        entries: [
          { ...body.entries[0], exchange_rate: '32.5' },
          body.entries[1],
        ],
      })
    ).fx_comparisons[0],
  ).toMatchObject({
    reference_source: 'user_input',
    reference_rate: '32.5000000000',
  });
  const saved = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${f.ledger}/transactions`,
    headers: f.headers,
    payload: body,
  });
  expect(saved.statusCode).toBe(201);
  expect(saved.json().fx_comparisons[0].reference_source).toBe(
    'exchange_rates',
  );
  const rates = await transactionService(f.db).rates(
    f.actor,
    f.ledger,
    '2026-10-21',
  );
  expect(rates).toHaveLength(0);
});
it('non-TWD common-date cross quotes match independent PostgreSQL numeric, including inverse and one-sided rates', async () => {
  const oracle = JSON.parse(fixtureText('oracle.json')) as {
    from: string;
    to: string;
    buy: string | null;
    sell: string | null;
    base_buy: string;
    base_sell: string;
    expected_rate: string;
  }[];
  for (const o of oracle) {
    await f.db`DELETE FROM market_fx_rates`;
    if (o.from !== 'TWD')
      await f.db`INSERT INTO market_fx_rates(rate_date,currency,source,spot_buy,spot_sell) VALUES ('2026-10-22',${o.from},'bot',${o.buy},${o.sell})`;
    await f.db`INSERT INTO market_fx_rates(rate_date,currency,source,spot_buy,spot_sell) VALUES ('2026-10-22',${o.to},'bot',${o.base_buy},${o.base_sell})`;
    const ledger = (
      await ledgerService(f.db).create(f.actor, {
        name: '合成交叉 ' + randomUUID(),
        base_currency: o.to,
      })
    ).id;
    const rates = await transactionService(f.db).rates(
      f.actor,
      ledger,
      '2026-10-22',
    );
    const q = rates.find((r) => r.from_currency === o.from)!;
    const [independent] =
      await f.db`SELECT round((CASE WHEN ${o.from}='TWD' THEN 1::numeric ELSE COALESCE((${o.buy}::numeric+${o.sell}::numeric)/2,${o.buy}::numeric,${o.sell}::numeric) END)/((${o.base_buy}::numeric+${o.base_sell}::numeric)/2),10)::text rate`;
    expect(q.rate).toBe(independent!.rate);
    expect(q.rate).toBe(o.expected_rate);
    expect(q.source).toBe('bot-cross');
  }
  await f.db`DELETE FROM market_fx_rates`;
  await f.db`INSERT INTO market_fx_rates(rate_date,currency,source,spot_buy,spot_sell) VALUES ('2026-10-20','EUR','bot',35.5,35.5),('2026-10-20','USD','bot',32.5,32.5),('2026-10-21','USD','bot',32.75,32.75),('2026-10-22','EUR','bot',36.5,36.5)`;
  const ledger = (
    await ledgerService(f.db).create(f.actor, {
      name: '合成共同日 ' + randomUUID(),
      base_currency: 'USD',
    })
  ).id;
  const rates = await transactionService(f.db).rates(
    f.actor,
    ledger,
    '2026-10-22',
  );
  expect(rates.find((r) => r.from_currency === 'EUR')).toMatchObject({
    rate: '1.0923076923',
    rate_date: '2026-10-20',
  });
  expect(rates.find((r) => r.from_currency === 'TWD')).toMatchObject({
    rate: '0.0305343511',
    rate_date: '2026-10-21',
  });
});
it('foreign asset/liability revaluation preserves historical SQL totals, rolls up naturally, and writes no accounting data', async () => {
  const ledger = (
      await ledgerService(f.db).create(f.actor, {
        name: '合成市值 ' + randomUUID(),
      })
    ).id,
    items = itemService(f.db);
  const root = await items.create(f.actor, ledger, {
      name: '合成資產根',
      kind: 'asset',
      currency: 'TWD',
    }),
    usd = await items.create(f.actor, ledger, {
      name: '合成美元',
      kind: 'asset',
      currency: 'USD',
      parent_id: root.id,
    }),
    cash = await items.create(f.actor, ledger, {
      name: '合成銀行',
      kind: 'asset',
      currency: 'TWD',
      parent_id: root.id,
    }),
    equity = await items.create(f.actor, ledger, {
      name: '合成權益',
      kind: 'equity',
      currency: 'TWD',
    }),
    liability = await items.create(f.actor, ledger, {
      name: '合成美元負債',
      kind: 'liability',
      currency: 'USD',
    }),
    missing = await items.create(f.actor, ledger, {
      name: '合成無行情歐元',
      kind: 'asset',
      currency: 'EUR',
    });
  await transactionService(f.db).create(f.actor, ledger, {
    occurred_on: '2026-10-20',
    entries: [
      { item_id: usd.id, amount: '100', exchange_rate: '30' },
      { item_id: equity.id, amount: '-3000' },
    ],
  });
  await transactionService(f.db).create(f.actor, ledger, {
    occurred_on: '2026-10-20',
    entries: [
      { item_id: liability.id, amount: '-50', exchange_rate: '30' },
      { item_id: cash.id, amount: '1500' },
    ],
  });
  await transactionService(f.db).create(f.actor, ledger, {
    occurred_on: '2026-10-20',
    entries: [
      { item_id: missing.id, amount: '10', exchange_rate: '35' },
      { item_id: equity.id, amount: '-350' },
    ],
  });
  await marketService(f.db).upload(f.actor, ledger, upload(), now);
  const counts = async () =>
    JSON.stringify(
      (
        await f.db`SELECT (SELECT count(*) FROM transactions) tx,(SELECT count(*) FROM transaction_entries) entries,(SELECT count(*) FROM audit_logs) audit`
      )[0],
    );
  const before = await counts();
  const [raw] =
    await f.db`SELECT report_balance_sheet(${f.actor},${ledger},'2026-10-22'::date) r`;
  const r = await reportService(f.db).balance(f.actor, ledger, {
    as_of: '2026-10-22',
  });
  expect(r.totals).toEqual(raw!.r.totals);
  expect(r.totals.net_worth).toBe('3350.00');
  expect(r.market).toMatchObject({
    assets: '5035.00',
    liabilities: '1592.50',
    net_worth: '3442.50',
    unrealized_amount: '92.50',
  });
  expect(r.items.find((i) => i.id === usd.id)?.valuation).toMatchObject({
    market_amount: '3185.00',
    rate_date: '2026-10-22',
    source: 'bot',
  });
  expect(
    r.items.find((i) => i.id === liability.id)?.valuation?.market_amount,
  ).toBe('1592.50');
  expect(r.items.find((i) => i.id === root.id)?.valuation?.market_amount).toBe(
    '4685.00',
  );
  expect(r.items.find((i) => i.id === missing.id)?.valuation).toMatchObject({
    market_amount: '350.00',
    missing: true,
    source: 'missing',
  });
  expect(await counts()).toBe(before);
  const via = await f.app.inject({
    url: `/api/ledgers/${ledger}/reports/balance-sheet?as_of=2026-10-22`,
    headers: f.headers,
  });
  expect(via.statusCode).toBe(200);
  expect(via.json().market.net_worth).toBe('3442.50');
  expect(await counts()).toBe(before);
  const outsider = await f.app.inject({
    url: `/api/ledgers/${ledger}/reports/balance-sheet?as_of=bad`,
    headers: f.otherHeaders,
  });
  expect(outsider.statusCode).toBe(404);
  const backup = await backupService(f.db).download(f.actor, ledger);
  for (const name of [
    'market_fx_rates',
    'market_prices',
    'market_fetch_runs',
    'market_calendar',
  ])
    expect(JSON.stringify(backup)).not.toContain(name);
});
it('run freshness uses official calendar, missing-year weekday fallback and independent FX weekdays', async () => {
  const { readMarketRuns, parseCalendar } = await import('@finmichi/core');
  const batch = parseCalendar(fixtureText('calendar.json'), [2026, 2027]);
  await f.db.begin((sql) => applyMarketBatch(sql, batch, now));
  await f.db`INSERT INTO market_fetch_runs(source,status,data_date) VALUES ('bot','success','2026-10-19'),('twse','success','2026-10-19'),('tpex','success','2026-10-19')`;
  const known = await f.db.begin((sql) =>
    readMarketRuns(sql, new Date('2026-10-27T02:00:00Z')),
  );
  expect(known.find((r) => r.source === 'bot')).toMatchObject({
    stale: true,
    estimated_days: true,
  });
  expect(known.find((r) => r.source === 'twse')).toMatchObject({
    stale: true,
    estimated_days: false,
  });
  await f.db`UPDATE market_fetch_runs SET data_date='2028-01-03' WHERE source='twse'`;
  const fallback = await f.db.begin((sql) =>
    readMarketRuns(sql, new Date('2028-01-10T02:00:00Z')),
  );
  expect(fallback.find((r) => r.source === 'twse')).toMatchObject({
    stale: true,
    estimated_days: true,
  });
});

it('dashboard missing latest prices is ledger-scoped, ignores archived securities, and never writes', async () => {
  const otherLedger = await ledgerService(f.db).create(f.actor, {
    name: 'synthetic other ledger',
  });
  const make = async (ledger: string, symbol: string, archived = false) => {
    const item = await itemService(f.db).create(f.actor, ledger, {
      name: 'synthetic stocks ' + symbol,
      kind: 'asset',
      currency: 'TWD',
      securities: true,
    });
    const security = await securityService(f.db).create(f.actor, ledger, {
      symbol,
      name: 'synthetic ' + symbol,
      market: 'TPEx',
      kind: 'stock',
      item_id: item.id,
    });
    if (archived)
      await f.db`UPDATE securities SET archived=true WHERE id=${security.id}`;
    return security;
  };
  await make(f.ledger, '9999A');
  await make(f.ledger, '9999B', true);
  await make(otherLedger.id, '9999C');
  const source = parsePrices('tpex', fixtureText('tpex.json'));
  source.skipped_no_price = 999;
  source.row_count = 1000;
  source.warning = true;
  await f.db.begin((sql) => applyMarketBatch(sql, source, now));
  const snapshot = async () =>
    JSON.stringify(
      await f.db`SELECT (SELECT count(*) FROM audit_logs) audit,(SELECT count(*) FROM securities) securities,(SELECT count(*) FROM market_prices) prices,(SELECT jsonb_agg(r ORDER BY source) FROM market_fetch_runs r) runs`,
    );
  const read = async (ledger = f.ledger) => {
    const response = await f.app.inject({
      url: '/api/ledgers/' + ledger + '/market',
      headers: f.headers,
    });
    expect(response.statusCode).toBe(200);
    return response
      .json()
      .price_coverage.find((c: { source: string }) => c.source === 'tpex');
  };
  const before = await snapshot();
  expect(await read()).toMatchObject({
    tracked_securities: 1,
    missing_prices: 0,
    data_date: '2026-10-22',
  });
  expect(await read(otherLedger.id)).toMatchObject({
    tracked_securities: 1,
    missing_prices: 1,
  });
  expect(
    (await f.app.inject({ url: path(), headers: f.otherHeaders })).statusCode,
  ).toBe(404);
  expect(await snapshot()).toBe(before);
  // A newer response without this security must flag stale-per-security data,
  // even when the source-wide skipped ratio is small. Manual valuation is unchanged.
  await f.db`UPDATE market_fetch_runs SET data_date='2026-10-23',skipped_no_price=1,status='success',error_code=NULL WHERE source='tpex'`;
  expect(await read()).toMatchObject({
    missing_prices: 1,
    data_date: '2026-10-23',
  });
  await f.db`INSERT INTO market_prices (trade_date,market,symbol,close,source) VALUES ('2026-10-23','TPEx','9999A',11,'tpex')`;
  expect(await read()).toMatchObject({ missing_prices: 0 });
  await f.db`UPDATE securities SET archived=true WHERE ledger_id=${f.ledger}`;
  await f.db`DELETE FROM market_prices`;
  expect(await read()).toMatchObject({
    tracked_securities: 0,
    missing_prices: 0,
  });
  await f.db`UPDATE securities SET archived=false WHERE ledger_id=${f.ledger}`;
  await f.db`DELETE FROM market_fetch_runs WHERE source='tpex'`;
  expect(await read()).toMatchObject({
    data_date: null,
    tracked_securities: 2,
    missing_prices: 2,
  });
});
it('TWSE CSV stores source dates and older CSV never replaces newer cached prices; challenge cap is two per day', async () => {
  const csv = fixtureText('twse.csv');
  const batch = parseTwseCsv(csv);
  await f.db.begin((sql) => applyMarketBatch(sql, batch, now));
  const before = JSON.stringify(
    await f.db`SELECT * FROM market_prices ORDER BY symbol`,
  );
  await f.db.begin((sql) =>
    applyMarketBatch(
      sql,
      parseTwseCsv(csv.replaceAll('1151022', '1151021')),
      now,
    ),
  );
  expect(
    JSON.stringify(await f.db`SELECT * FROM market_prices ORDER BY symbol`),
  ).toBe(before);
  await calendarDone();
  await f.db`DELETE FROM market_fetch_runs WHERE source='twse'`;
  const calls: string[] = [];
  const normal = clientFor().client;
  const client: MarketFetch = async (url, init) => {
    if (String(url).includes('STOCK_DAY_ALL')) {
      calls.push(String(url));
      return new Response('<html>challenge</html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    return normal(url, init);
  };
  for (const minutes of [0, 31, 62])
    await runMarketWorker(
      f.db,
      new Date(now.getTime() + minutes * 60000),
      client,
    );
  expect(calls).toHaveLength(2);
  expect(
    (
      await f.db`SELECT status,next_retry_at FROM market_fetch_runs WHERE source='twse'`
    )[0],
  ).toMatchObject({ status: 'blocked_by_source', next_retry_at: null });
  expect(
    JSON.stringify(
      await f.db`SELECT * FROM market_prices WHERE source='twse' ORDER BY symbol`,
    ),
  ).toBe(before);
});
