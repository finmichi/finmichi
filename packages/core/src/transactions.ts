// SPDX-License-Identifier: AGPL-3.0-only
import { assertPostableItem } from './postable.js';
import { readMarketFx } from './market-store.js';
import { findMarketRate } from './market-math.js';
import type { MarketQuote } from './market-schemas.js';
import { queryService } from './queries.js';
function decimalEqual(a: string, b: string) {
  const normalize = (s: string) =>
    s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return normalize(a) === normalize(b);
}
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema, type Item, type Ledger } from './catalog-schemas.js';
import { calculateBaseAmounts, MoneyError } from './money.js';
import {
  dateSchema,
  transactionCreateSchema,
  transactionUpdateSchema,
  type TransactionInput,
  type TransactionRecord,
  type Entry,
  type Preview,
} from './transaction-schemas.js';
function unlocked(ledger: Ledger, ...dates: string[]) {
  if (ledger.locked_until && dates.some((d) => d <= ledger.locked_until!))
    throw new DomainError('period_locked', 409);
}
async function record(
  sql: Transaction,
  ledger: string,
  id: string,
): Promise<TransactionRecord> {
  const [row] = await sql<
    Omit<TransactionRecord, 'entries'>[]
  >`SELECT id,ledger_id,occurred_on::text,memo,payee_id,project_id,invoice_no,kind FROM transactions WHERE ledger_id=${ledger} AND id=${id}`;
  if (!row) throw new DomainError('not_found', 404);
  const entries = await sql<
    Entry[]
  >`SELECT id,item_id,amount::text,currency,exchange_rate::text,base_amount::text,entry_position FROM transaction_entries WHERE ledger_id=${ledger} AND transaction_id=${id} ORDER BY entry_position`;
  const [managed] =
    await sql`SELECT id AS security_trade_id,security_id FROM security_trades WHERE ledger_id=${ledger} AND transaction_id=${id}`;
  const [dividend] =
    await sql`SELECT id FROM dividends WHERE ledger_id=${ledger} AND transaction_id=${id}`;
  const [deposit] =
    await sql`SELECT deposit_id FROM deposit_postings WHERE ledger_id=${ledger} AND transaction_id=${id}`;
  return {
    ...row,
    entries,
    ...(dividend ? { dividend_id: String(dividend.id) } : {}),
    ...(deposit ? { deposit_id: String(deposit.deposit_id) } : {}),
    ...(managed
      ? {
          security_trade_id: String(managed.security_trade_id),
          security_id: String(managed.security_id),
        }
      : {}),
  };
}
export async function transactionReference(
  sql: Transaction,
  ledger: string,
  date: string,
  currency: string,
  base: string,
) {
  if (currency === base) return { rate: '1', source: 'base' as const };
  const [r] =
    await sql`SELECT rate::text FROM exchange_rates WHERE ledger_id=${ledger} AND rate_date=${date} AND from_currency=${currency} AND to_currency=${base}`;
  if (r) return { rate: String(r.rate), source: 'exchange_rates' as const };
  return (
    findMarketRate(await readMarketFx(sql, date), currency, base, date) ??
    undefined
  );
}
async function calculate(
  sql: Transaction,
  ledger: Ledger,
  data: TransactionInput,
  old?: TransactionRecord,
  rateInputs = data.entries,
  allowSecurities = false,
  allowArchivedReplay = false,
  historicalImport = false,
): Promise<Preview> {
  for (const resource of ['payees', 'projects'] as const) {
    const key = resource === 'payees' ? 'payee_id' : 'project_id',
      id = data[key];
    if (!id) continue;
    const [row] =
      await sql`SELECT archived FROM ${sql(resource)} WHERE id=${id} AND ledger_id=${ledger.id}`;
    if (!row)
      throw new DomainError(
        resource === 'payees'
          ? 'payee_ledger_mismatch'
          : 'project_ledger_mismatch',
        400,
      );
    if (row.archived && old?.[key] !== id)
      throw new DomainError('archived_resource', 400);
  }
  const items: Item[] = [],
    refs: (
      | { rate: string; source: 'base' | 'exchange_rates' }
      | MarketQuote
      | undefined
    )[] = [];
  const oldItemIds = old?.entries.map((e) => e.item_id) ?? [];
  for (const e of data.entries) {
    const [item] = await sql<
      Item[]
    >`SELECT * FROM items WHERE id=${e.item_id} AND ledger_id=${ledger.id}`;
    if (!item) throw new DomainError('item_ledger_mismatch', 400);
    if (item.securities && !allowSecurities)
      throw new DomainError('security_item_requires_trade', 400);
    const previous = oldItemIds.indexOf(e.item_id);
    if (!historicalImport)
      await assertPostableItem(
        sql,
        ledger.id,
        e.item_id,
        previous >= 0 || (item.archived && allowArchivedReplay),
      );
    if (previous >= 0) oldItemIds.splice(previous, 1);
    items.push(item);
    refs.push(
      await transactionReference(
        sql,
        ledger.id,
        data.occurred_on,
        item.currency,
        ledger.base_currency,
      ),
    );
  }
  const foreign = items.filter(
    (i) => i.currency !== ledger.base_currency,
  ).length;
  const scenarioC = foreign === 1 && foreign < items.length;
  const inputs = data.entries.map((e, i) => {
    const rate =
      (scenarioC ? rateInputs[i]?.exchange_rate : e.exchange_rate) ??
      refs[i]?.rate;
    if (
      items[i]!.currency !== ledger.base_currency &&
      !scenarioC &&
      rate === undefined
    )
      throw new DomainError('exchange_rate_missing', 400);
    return {
      itemId: e.item_id,
      amount: e.amount,
      currency: items[i]!.currency,
      ...(rate === undefined ? {} : { exchangeRate: rate }),
    };
  });
  try {
    const result = calculateBaseAmounts(inputs, ledger.base_currency);
    const entries = result.entries.map((e, i) => ({
      item_id: data.entries[i]!.item_id,
      amount: e.amount,
      currency: e.currency,
      exchange_rate: e.exchangeRate,
      base_amount: e.baseAmount,
    }));
    // Archived legs may survive unchanged; no new or changed use is accepted.
    const available =
      old?.entries
        .filter((e) => items.some((i) => i.id === e.item_id && i.archived))
        .map((e) => ({ ...e })) ?? [];
    for (let i = 0; i < items.length; i++)
      if (items[i]!.archived && !allowArchivedReplay) {
        const e = entries[i]!;
        const index = available.findIndex(
          (a) =>
            a.item_id === e.item_id &&
            decimalEqual(a.amount, e.amount) &&
            decimalEqual(a.exchange_rate, e.exchange_rate) &&
            decimalEqual(a.base_amount, e.base_amount),
        );
        if (index < 0) throw new DomainError('archived_resource', 400);
        available.splice(index, 1);
      }
    const kinds = items.map((i) => i.kind);
    const kind = kinds.includes('income')
      ? 'income'
      : kinds.includes('expense')
        ? 'expense'
        : kinds.length >= 2 &&
            kinds.every((k) => k === 'asset' || k === 'liability')
          ? 'transfer'
          : 'adjustment';
    return {
      entries,
      kind,
      fx_comparisons: result.fxComparisons.map((c) => ({
        entry_index: c.entryIndex,
        effective_rate: c.effectiveRate,
        reference_rate: c.referenceRate,
        reference_source:
          rateInputs[c.entryIndex]?.exchange_rate !== undefined
            ? 'user_input'
            : refs[c.entryIndex]?.source === 'bot' ||
                refs[c.entryIndex]?.source === 'bot-cross'
              ? (refs[c.entryIndex]!.source as 'bot' | 'bot-cross')
              : refs[c.entryIndex] !== undefined
                ? 'exchange_rates'
                : 'none',
        ...((refs[c.entryIndex] as MarketQuote | undefined)?.rate_date &&
        rateInputs[c.entryIndex]?.exchange_rate === undefined
          ? { reference_date: (refs[c.entryIndex] as MarketQuote).rate_date }
          : {}),
        deviation_percent: c.deviationPercent,
      })),
      scenario: result.scenario,
      warnings: result.warnings,
    };
  } catch (error) {
    if (error instanceof MoneyError) throw new DomainError(error.code, 400);
    throw error;
  }
}
export async function saveTransactionEntries(
  sql: Transaction,
  ledger: string,
  id: string,
  entries: Preview['entries'],
) {
  await sql`DELETE FROM transaction_entries WHERE ledger_id=${ledger} AND transaction_id=${id}`;
  await sql`INSERT INTO transaction_entries ${sql(entries.map((e, entry_position) => ({ ...e, ledger_id: ledger, transaction_id: id, entry_position })))}`;
}
export async function previewTransaction(
  sql: Transaction,
  l: Ledger,
  input: unknown,
  old?: TransactionRecord,
  allowSecurities = false,
  allowArchivedReplay = false,
  historicalImport = false,
) {
  const data = valid(transactionCreateSchema, input);
  unlocked(l, data.occurred_on, ...(old ? [old.occurred_on] : []));
  return calculate(
    sql,
    l,
    data,
    old,
    data.entries,
    allowSecurities,
    allowArchivedReplay,
    historicalImport,
  );
}
export async function createTransaction(
  sql: Transaction,
  l: Ledger,
  input: unknown,
  allowSecurities = false,
  allowArchivedReplay = false,
  historicalImport = false,
) {
  const data = valid(transactionCreateSchema, input),
    ledger = l.id;
  const calc = await previewTransaction(
    sql,
    l,
    data,
    undefined,
    allowSecurities,
    allowArchivedReplay,
    historicalImport,
  );
  const { entries: _, ...fields } = data;
  void _;
  const [row] =
    await sql`INSERT INTO transactions ${sql({ ...fields, ledger_id: ledger, kind: calc.kind })} RETURNING id`;
  await saveTransactionEntries(sql, ledger, String(row!.id), calc.entries);
  return {
    ...(await record(sql, ledger, String(row!.id))),
    scenario: calc.scenario,
    fx_comparisons: calc.fx_comparisons,
    warnings: calc.warnings,
  };
}
export function transactionService(db: Database) {
  return {
    async list(actor: string, ledgerId: unknown, query: unknown = {}) {
      return queryService(db).search(actor, ledgerId, query);
    },
    async get(actor: string, ledgerId: unknown, transactionId: unknown) {
      const ledger = valid(idSchema, ledgerId),
        id = valid(idSchema, transactionId);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        return record(sql, ledger, id);
      });
    },
    async rates(actor: string, ledgerId: unknown, date: unknown) {
      const ledger = valid(idSchema, ledgerId),
        day = valid(dateSchema, date);
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, actor, ledger);
        const saved = await sql<
          {
            from_currency: string;
            to_currency: string;
            rate: string;
            source?: string;
            rate_date?: string;
          }[]
        >`SELECT from_currency,to_currency,rate::text FROM exchange_rates WHERE ledger_id=${ledger} AND rate_date=${day} AND to_currency=${l.base_currency} ORDER BY from_currency`;
        const cache = await readMarketFx(sql, day),
          currencies = [...new Set([...cache.map((r) => r.currency), 'TWD'])];
        for (const currency of currencies)
          if (
            currency !== l.base_currency &&
            !saved.some((r) => r.from_currency === currency)
          ) {
            const q = findMarketRate(cache, currency, l.base_currency, day);
            if (q)
              saved.push({
                from_currency: currency,
                to_currency: l.base_currency,
                rate: q.rate,
                source: q.source,
                rate_date: q.rate_date,
              });
          }
        return saved.sort((a, b) =>
          a.from_currency.localeCompare(b.from_currency),
        );
      });
    },
    async preview(
      actor: string,
      ledgerId: unknown,
      input: unknown,
      transactionId?: unknown,
    ) {
      const ledger = valid(idSchema, ledgerId),
        data = valid(transactionCreateSchema, input);
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, actor, ledger);
        const old =
          transactionId === undefined
            ? undefined
            : await record(sql, ledger, valid(idSchema, transactionId));
        return previewTransaction(sql, l, data, old);
      });
    },
    async create(actor: string, ledgerId: unknown, input: unknown) {
      return mutation(db, actor, 'transaction.create', async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          data = valid(transactionCreateSchema, input);
        const l = await ownedLedger(sql, actor, ledger);
        return createTransaction(sql, l, data);
      });
    },
    async update(
      actor: string,
      ledgerId: unknown,
      transactionId: unknown,
      input: unknown,
    ) {
      return mutation(db, actor, 'transaction.update', async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          id = valid(idSchema, transactionId),
          patch = valid(transactionUpdateSchema, input);
        const l = await ownedLedger(sql, actor, ledger),
          old = await record(sql, ledger, id);
        if (
          (
            await sql`SELECT 1 FROM deposit_postings WHERE ledger_id=${ledger} AND transaction_id=${id}`
          ).length
        )
          throw new DomainError('deposit_managed_transaction', 409);
        if (
          (
            await sql`SELECT 1 FROM dividends WHERE ledger_id=${ledger} AND transaction_id=${id}`
          ).length
        )
          throw new DomainError('dividend_managed_transaction', 409);
        if (old.security_trade_id)
          throw new DomainError('security_trade_managed', 409);
        unlocked(l, old.occurred_on, patch.occurred_on ?? old.occurred_on);
        const data: TransactionInput = {
          occurred_on: patch.occurred_on ?? old.occurred_on,
          memo: patch.memo ?? old.memo,
          payee_id:
            patch.payee_id === undefined ? old.payee_id : patch.payee_id,
          project_id:
            patch.project_id === undefined ? old.project_id : patch.project_id,
          invoice_no: patch.invoice_no ?? old.invoice_no,
          entries:
            patch.entries ??
            old.entries.map((e) => ({
              item_id: e.item_id,
              amount: e.amount,
              exchange_rate: e.exchange_rate,
            })),
        };
        const calc = await calculate(sql, l, data, old, patch.entries ?? []);
        const { entries: _, ...fields } = data;
        void _;
        await sql`UPDATE transactions SET ${sql({ ...fields, kind: calc.kind })} WHERE id=${id} AND ledger_id=${ledger}`;
        await saveTransactionEntries(sql, ledger, id, calc.entries);
        return {
          ...(await record(sql, ledger, id)),
          scenario: calc.scenario,
          fx_comparisons: calc.fx_comparisons,
          warnings: calc.warnings,
        };
      });
    },
    async remove(actor: string, ledgerId: unknown, transactionId: unknown) {
      return mutation(db, actor, 'transaction.delete', async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          id = valid(idSchema, transactionId);
        const l = await ownedLedger(sql, actor, ledger),
          old = await record(sql, ledger, id);
        if (
          (
            await sql`SELECT 1 FROM deposit_postings WHERE ledger_id=${ledger} AND transaction_id=${id}`
          ).length
        )
          throw new DomainError('deposit_managed_transaction', 409);
        if (
          (
            await sql`SELECT 1 FROM dividends WHERE ledger_id=${ledger} AND transaction_id=${id}`
          ).length
        )
          throw new DomainError('dividend_managed_transaction', 409);
        if (old.security_trade_id)
          throw new DomainError('security_trade_managed', 409);
        unlocked(l, old.occurred_on);
        await sql`UPDATE import_source_records SET target_id='deleted:'||target_id WHERE ledger_id=${ledger} AND target_table='transactions' AND lower(target_id)=${id}`;
        await sql`DELETE FROM transactions WHERE ledger_id=${ledger} AND id=${id}`;
      });
    },
  };
}
