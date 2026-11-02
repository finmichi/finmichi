// SPDX-License-Identifier: AGPL-3.0-only
import { assertPostableItem } from './postable.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema, type Ledger, type Item } from './catalog-schemas.js';
import {
  depositSchema,
  depositPreviewSchema,
  depositWriteSchema,
  depositRevokeSchema,
  depositReportSchema,
  type DepositInput,
  type DepositRecord,
  type DepositPosting,
} from './deposit-schemas.js';
import {
  depositSchedule,
  depositNet,
  renewedTerm,
  depositDays,
  DepositCalculationError,
} from './deposit-math.js';
import { stockUnits, stockFixed, stockDivide } from './securities-math.js';
import {
  previewTransaction,
  createTransaction,
  transactionReference,
} from './transactions.js';
import { canonicalJson } from './backups.js';
import { taipeiToday } from './ledger-lock.js';
import { readMarketFx } from './market-store.js';
import { findMarketRate } from './market-math.js';
import { addDays } from './finance-calendar.js';
function calculation<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof DepositCalculationError)
      throw new DomainError(e.code, 400);
    throw e;
  }
}
function unlocked(l: Ledger, date: string) {
  if (l.locked_until && date <= l.locked_until)
    throw new DomainError('period_locked', 409);
}
export async function depositRows(sql: Transaction, ledger: string) {
  return await sql<
    DepositRecord[]
  >`SELECT *,principal::text,annual_rate::text,start_on::text,maturity_on::text FROM fixed_deposits WHERE ledger_id=${ledger} ORDER BY fixed_deposits.maturity_on,fixed_deposits.id`;
}
export async function depositPostings(sql: Transaction, ledger: string) {
  return await sql<
    DepositPosting[]
  >`SELECT *,posted_on::text,gross_interest::text,withholding_tax::text,nhi_premium::text FROM deposit_postings WHERE ledger_id=${ledger} ORDER BY deposit_postings.posted_on,deposit_postings.id`;
}
async function record(sql: Transaction, ledger: string, id: string) {
  const d = (await depositRows(sql, ledger)).find((r) => r.id === id);
  if (!d) throw new DomainError('not_found', 404);
  return d;
}
async function accounts(
  sql: Transaction,
  l: Ledger,
  d: DepositInput,
  allowArchived = false,
  old?: DepositInput,
) {
  const rows = await sql<
    Item[]
  >`SELECT * FROM items WHERE ledger_id=${l.id} AND id IN (${d.item_id},${d.payout_account_id},${d.interest_item_id})`;
  const item = rows.find((i) => i.id === d.item_id),
    bank = rows.find((i) => i.id === d.payout_account_id),
    income = rows.find((i) => i.id === d.interest_item_id);
  if (!item || !bank || !income) throw new DomainError('not_found', 404);
  if (
    item.kind !== 'asset' ||
    item.securities ||
    item.credit_card ||
    item.loan ||
    bank.kind !== 'asset' ||
    bank.securities ||
    income.kind !== 'income' ||
    income.currency !== l.base_currency
  )
    throw new DomainError('invalid_input', 400);
  if (item.currency !== bank.currency)
    throw new DomainError('deposit_currency_mismatch', 400);
  for (const key of [
    'item_id',
    'payout_account_id',
    'interest_item_id',
  ] as const)
    await assertPostableItem(
      sql,
      l.id,
      d[key],
      old?.[key] === d[key] ||
        (allowArchived && rows.find((i) => i.id === d[key])?.archived === true),
    );
  return { item, bank, income };
}
export async function readDeposits(
  sql: Transaction,
  l: Ledger,
  asOf = taipeiToday(),
) {
  const data = await depositRows(sql, l.id),
    postings = await depositPostings(sql, l.id),
    items = await sql<Item[]>`SELECT * FROM items WHERE ledger_id=${l.id}`,
    fx = await readMarketFx(sql, asOf);
  let principal = 0n,
    interest = 0n,
    missing = 0;
  const deposits = data.map((d) => {
    const item = items.find((i) => i.id === d.item_id)!,
      bank = items.find((i) => i.id === d.payout_account_id)!,
      schedule = calculation(() => depositSchedule(d)),
      ps = postings.filter((p) => p.deposit_id === d.id),
      rate =
        item.currency === l.base_currency
          ? { rate: '1', source: 'base', rate_date: asOf }
          : findMarketRate(fx, item.currency, l.base_currency, asOf);
    if (d.status === 'active') {
      if (rate) {
        principal += stockDivide(
          stockUnits(d.principal) * stockUnits(rate.rate, 10),
          10000000000n,
        );
        interest += stockDivide(
          stockUnits(schedule.total_interest) * stockUnits(rate.rate, 10),
          10000000000n,
        );
      } else missing++;
    }
    return {
      ...d,
      currency: item.currency,
      item_name: item.name,
      payout_account_name: bank.name,
      remaining_days: depositDays(asOf, d.maturity_on),
      total_interest: schedule.total_interest,
      posted_interest: stockFixed(
        ps.reduce((s, p) => s + stockUnits(p.gross_interest), 0n),
      ),
      postings: ps,
      schedule: schedule.periods.map((p) => ({
        ...p,
        posted: ps.some(
          (x) => x.kind === 'settlement' || x.period_no === p.period_no,
        ),
      })),
      valuation: rate ?? null,
    };
  });
  return {
    as_of: asOf,
    base_currency: l.base_currency,
    deposits,
    totals: {
      active_principal: stockFixed(principal),
      estimated_interest: stockFixed(interest),
      missing_market_rates: missing,
    },
  };
}
async function plan(sql: Transaction, l: Ledger, id: string, input: unknown) {
  const req = valid(depositPreviewSchema, input),
    d = await record(sql, l.id, id),
    ps = (await depositPostings(sql, l.id)).filter((p) => p.deposit_id === id);
  if (req.operation === 'revoke') {
    const posting = ps.find((p) => p.id === req.posting_id);
    if (!posting) throw new DomainError('not_found', 404);
    unlocked(l, posting.posted_on);
    const renewal = posting.renewed_deposit_id
      ? await record(sql, l.id, posting.renewed_deposit_id)
      : null;
    if (
      renewal &&
      (
        await sql`SELECT 1 FROM deposit_postings WHERE ledger_id=${l.id} AND deposit_id=${renewal.id}`
      ).length
    )
      throw new DomainError('deposit_renewal_in_use', 409);
    return {
      req,
      d,
      posting,
      renewal,
      cash: null,
      transaction: null,
      hash: createHash('sha256')
        .update(canonicalJson({ req, d, ps, renewal, lock: l.locked_until }))
        .digest('hex'),
    };
  }
  const a = req.amounts!;
  calculation(() => depositNet(a));
  unlocked(l, a.posted_on);
  if (d.status !== 'active')
    throw new DomainError('deposit_period_posted', 409);
  const schedule = calculation(() => depositSchedule(d));
  if (req.operation === 'interest') {
    if (
      d.payout !== 'monthly' ||
      a.renew !== 'none' ||
      !schedule.periods.some((p) => p.period_no === a.period_no)
    )
      throw new DomainError('invalid_input', 400);
    if (ps.some((p) => p.period_no === a.period_no))
      throw new DomainError('deposit_period_posted', 409);
  } else {
    if (a.period_no !== undefined) throw new DomainError('invalid_input', 400);
    if (
      ps.some((p) => p.period_no === schedule.periods.at(-1)!.period_no) &&
      stockUnits(a.gross_interest) > 0n
    )
      throw new DomainError('deposit_period_posted', 409);
  }
  const { item } = await accounts(sql, l, d),
    gross = stockUnits(a.gross_interest),
    tax = stockUnits(a.withholding_tax) + stockUnits(a.nhi_premium),
    net = gross - tax;
  const ref = await transactionReference(
    sql,
    l.id,
    a.posted_on,
    item.currency,
    l.base_currency,
  );
  const noCash =
    gross === 0n && !(req.operation === 'settlement' && a.renew === 'none');
  const rate =
    item.currency === l.base_currency
      ? '1'
      : (a.exchange_rate ?? ref?.rate ?? (noCash ? '1' : undefined));
  if (!rate || stockUnits(rate, 10) <= 0n)
    throw new DomainError('exchange_rate_missing', 400);
  const convert = (v: bigint) =>
    stockDivide(v * stockUnits(rate, 10), 10000000000n);
  const entries: { item_id: string; amount: string; exchange_rate?: string }[] =
    [];
  const add = (item_id: string, value: bigint, foreign = false) => {
    if (value)
      entries.push({
        item_id,
        amount: stockFixed(value),
        ...(foreign ? { exchange_rate: rate } : {}),
      });
  };
  const none = req.operation === 'settlement' && a.renew === 'none';
  if (none) add(d.item_id, -stockUnits(d.principal), true);
  const receiver =
    req.operation === 'settlement' && a.renew === 'principal_and_interest'
      ? d.item_id
      : d.payout_account_id;
  add(receiver, (none ? stockUnits(d.principal) : 0n) + net, true);
  add(d.interest_item_id, -convert(gross));
  if (tax) {
    if (!a.tax_item_id) throw new DomainError('invalid_input', 400);
    const [t] = await sql<
      Item[]
    >`SELECT * FROM items WHERE ledger_id=${l.id} AND id=${a.tax_item_id}`;
    if (!t) throw new DomainError('not_found', 404);
    if (t.kind !== 'expense' || t.currency !== l.base_currency || t.archived)
      throw new DomainError('invalid_input', 400);
    add(t.id, convert(tax));
  }
  const transaction = entries.length
    ? { occurred_on: a.posted_on, memo: d.note, entries }
    : null;
  const cash = transaction
    ? await previewTransaction(sql, l, transaction)
    : null;
  const renewal =
    req.operation === 'settlement' && a.renew !== 'none'
      ? {
          ...valid(
            depositSchema,
            Object.fromEntries(
              Object.keys(depositSchema.shape).map((k) => [
                k,
                d[k as keyof DepositInput],
              ]),
            ),
          ),
          ...renewedTerm(d),
          principal: stockFixed(
            stockUnits(d.principal) +
              (a.renew === 'principal_and_interest' ? net : 0n),
          ),
        }
      : null;
  return {
    req,
    d,
    posting: null,
    renewal,
    cash,
    transaction,
    hash: createHash('sha256')
      .update(
        canonicalJson({ req, d, ps, cash, renewal, lock: l.locked_until }),
      )
      .digest('hex'),
  };
}
function publicPlan(p: Awaited<ReturnType<typeof plan>>) {
  return {
    preview_hash: p.hash,
    entries: p.cash?.entries ?? [],
    fx_comparisons: p.cash?.fx_comparisons ?? [],
    renewal: p.renewal,
    creates_transaction: !!p.transaction,
  };
}
export function depositService(db: Database) {
  const read = async <T>(
    actor: string,
    ledger: unknown,
    f: (sql: Transaction, l: Ledger) => Promise<T>,
  ) =>
    db.begin(async (sql) =>
      f(sql, await ownedLedger(sql, actor, valid(idSchema, ledger), false)),
    );
  return {
    list(actor: string, ledger: unknown, input: unknown = {}) {
      const q = valid(depositReportSchema, input);
      return read(actor, ledger, (sql, l) => readDeposits(sql, l, q.as_of));
    },
    upcoming(actor: string, ledger: unknown, days: number) {
      if (!Number.isInteger(days) || days < 0 || days > 366)
        throw new DomainError('invalid_input', 400);
      return read(actor, ledger, async (sql, l) => {
        const now = taipeiToday();
        return (await readDeposits(sql, l, now)).deposits.filter(
          (d) =>
            d.status === 'active' &&
            d.maturity_on >= now &&
            d.maturity_on <= addDays(now, days),
        );
      });
    },
    save(actor: string, ledger: unknown, input: unknown, id?: string) {
      return mutation(
        db,
        actor,
        id ? 'deposit.update' : 'deposit.create',
        async (sql) => {
          const l = await ownedLedger(sql, actor, valid(idSchema, ledger)),
            old = id ? await record(sql, l.id, valid(idSchema, id)) : null;
          const d = valid(
            depositSchema,
            old
              ? {
                  ...Object.fromEntries(
                    Object.keys(depositSchema.shape).map((k) => [
                      k,
                      old[k as keyof DepositInput],
                    ]),
                  ),
                  ...(input && typeof input === 'object' ? input : {}),
                }
              : input,
          );
          calculation(() => depositSchedule(d));
          const ps = old
            ? (await depositPostings(sql, l.id)).filter(
                (p) => p.deposit_id === old.id,
              )
            : [];
          if (ps.length) {
            for (const k of Object.keys(
              depositSchema.shape,
            ) as (keyof DepositInput)[]) {
              if (k === 'bank' || k === 'note') continue;
              const equal =
                k === 'principal' || k === 'annual_rate'
                  ? stockUnits(String(d[k]), 6) ===
                    stockUnits(String(old![k]), 6)
                  : d[k] === old![k];
              if (!equal) throw new DomainError('deposit_has_postings', 409);
            }
          }
          await accounts(sql, l, d, !!ps.length, old ?? undefined);
          const key = id ?? randomUUID();
          if (id)
            await sql`UPDATE fixed_deposits SET ${sql(d)} WHERE ledger_id=${l.id} AND id=${key}`;
          else
            await sql`INSERT INTO fixed_deposits ${sql({ ...d, id: key, ledger_id: l.id })}`;
          return record(sql, l.id, key);
        },
      );
    },
    delete(actor: string, ledger: unknown, id: string) {
      return mutation(db, actor, 'deposit.delete', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledger));
        await record(sql, l.id, valid(idSchema, id));
        if (
          (
            await sql`SELECT 1 FROM deposit_postings WHERE ledger_id=${l.id} AND deposit_id=${id}`
          ).length
        )
          throw new DomainError('deposit_has_postings', 409);
        await sql`DELETE FROM fixed_deposits WHERE ledger_id=${l.id} AND id=${id}`;
        return { deleted: true };
      });
    },
    preview(actor: string, ledger: unknown, id: string, input: unknown) {
      return read(actor, ledger, async (sql, l) =>
        publicPlan(await plan(sql, l, valid(idSchema, id), input)),
      );
    },
    apply(
      actor: string,
      ledger: unknown,
      id: string,
      operation: 'interest' | 'settlement' | 'revoke',
      input: unknown,
      postingId?: string,
    ) {
      return mutation(
        db,
        actor,
        operation === 'interest'
          ? 'deposit.interest'
          : operation === 'settlement'
            ? 'deposit.settle'
            : 'deposit.revoke',
        async (sql) => {
          const l = await ownedLedger(sql, actor, valid(idSchema, ledger));
          const w =
            operation === 'revoke'
              ? valid(depositRevokeSchema, input)
              : valid(depositWriteSchema, input);
          const { preview_hash, ...amounts } = w;
          const p = await plan(
            sql,
            l,
            valid(idSchema, id),
            operation === 'revoke'
              ? { operation, posting_id: valid(idSchema, postingId) }
              : { operation, amounts },
          );
          if (preview_hash !== p.hash)
            throw new DomainError('preview_stale', 409);
          if (operation === 'revoke') {
            const old = p.posting!;
            await sql`DELETE FROM deposit_postings WHERE ledger_id=${l.id} AND id=${old.id}`;
            if (old.transaction_id) {
              await sql`UPDATE import_source_records SET target_id='deleted:'||target_id WHERE ledger_id=${l.id} AND target_table='transactions' AND target_id=${old.transaction_id}`;
              await sql`DELETE FROM transactions WHERE ledger_id=${l.id} AND id=${old.transaction_id}`;
            }
            if (old.kind === 'settlement') {
              await sql`UPDATE fixed_deposits SET status='active' WHERE ledger_id=${l.id} AND id=${id}`;
              if (old.renewed_deposit_id)
                await sql`DELETE FROM fixed_deposits WHERE ledger_id=${l.id} AND id=${old.renewed_deposit_id}`;
            }
            return { revoked: true };
          }
          const a = p.req.amounts!,
            key = randomUUID();
          let tx: string | null = null,
            renewed: string | null = null;
          if (p.transaction) {
            const t = await createTransaction(sql, l, p.transaction);
            tx = t.id;
            await sql`UPDATE transactions SET source_system='deposit',source_id=${key} WHERE ledger_id=${l.id} AND id=${tx}`;
          }
          if (p.renewal) {
            renewed = randomUUID();
            await sql`INSERT INTO fixed_deposits ${sql({ ...p.renewal, id: renewed, ledger_id: l.id, renewed_from_id: id, status: 'active' })}`;
          }
          if (operation === 'settlement')
            await sql`UPDATE fixed_deposits SET status=${a.renew === 'none' && a.posted_on < p.d.maturity_on ? 'closed' : 'matured'} WHERE ledger_id=${l.id} AND id=${id}`;
          const posting: DepositPosting = {
            id: key,
            ledger_id: l.id,
            deposit_id: id,
            kind: operation,
            period_no: operation === 'interest' ? a.period_no! : null,
            posted_on: a.posted_on,
            gross_interest: a.gross_interest,
            withholding_tax: a.withholding_tax,
            nhi_premium: a.nhi_premium,
            renew: a.renew,
            renewed_deposit_id: renewed,
            transaction_id: tx,
          };
          await sql`INSERT INTO deposit_postings ${sql(posting)}`;
          return posting;
        },
      );
    },
  };
}

export type DepositReport = Awaited<ReturnType<typeof readDeposits>>;
