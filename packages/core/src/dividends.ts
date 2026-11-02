// SPDX-License-Identifier: AGPL-3.0-only
import { assertPostableItem } from './postable.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema, type Ledger, type Item } from './catalog-schemas.js';
import {
  dividendPreviewSchema,
  dividendWriteSchema,
  dividendDeleteSchema,
  dividendReportSchema,
  incomeCodeSchema,
  incomeCodeDisclaimer,
  type DividendInput,
} from './dividend-schemas.js';
import { validateDividend } from './dividend-math.js';
import {
  readSecurity,
  requireStockLedger,
  previewStockTrade,
  applyStockTrade,
} from './securities.js';
import { stockUnits, stockFixed } from './securities-math.js';
import {
  createTransaction,
  previewTransaction,
  saveTransactionEntries,
} from './transactions.js';
import type { TransactionRecord } from './transaction-schemas.js';
import { canonicalJson } from './backups.js';
import { dateSchema } from './transaction-schemas.js';
type DividendRow = DividendInput & {
  id: string;
  ledger_id: string;
  transaction_id: string | null;
  stock_trade_id: string | null;
};

async function rows(sql: Transaction, ledger: string, id?: string) {
  const data =
    await sql`SELECT d.*,d.ex_date::text,d.pay_date::text,d.per_share::text,d.shares::text,d.gross_amount::text,d.withholding_tax::text,d.nhi_premium::text,d.fee::text,d.net_amount::text,d.stock_shares::text FROM dividends d WHERE ledger_id=${ledger} AND (${id ?? null}::uuid IS NULL OR id=${id ?? null}) ORDER BY d.pay_date DESC,d.id DESC`;
  const result: DividendRow[] = [];
  for (const d of data) {
    const components =
      await sql`SELECT code,label,amount::text,taxable,income_item_id FROM dividend_components WHERE ledger_id=${ledger} AND dividend_id=${d.id} ORDER BY code,id`;
    result.push({ ...d, components } as unknown as DividendRow);
  }
  return result;
}
async function get(sql: Transaction, ledger: string, id: string) {
  const d = (await rows(sql, ledger, id))[0];
  if (!d) throw new DomainError('not_found', 404);
  return d;
}
function lock(l: Ledger, ...dates: string[]) {
  const affected = dates.filter((d) => l.locked_until && d <= l.locked_until);
  if (affected.length)
    throw new DomainError('period_locked', 409, { affected_dates: affected });
}
async function account(
  sql: Transaction,
  l: Ledger,
  id: string | null,
  kind: Item['kind'],
  oldIds: string[] = [],
) {
  if (!id) throw new DomainError('dividend_account_required', 400);
  const [r] = await sql<
    Item[]
  >`SELECT * FROM items WHERE ledger_id=${l.id} AND id=${id}`;
  if (!r) throw new DomainError('not_found', 404);
  if (r.currency !== 'TWD' || r.kind !== kind || r.securities)
    throw new DomainError('dividend_account_invalid', 400);
  if (r.archived && !oldIds.includes(id))
    throw new DomainError('archived_resource', 400);
  await assertPostableItem(sql, l.id, id, oldIds.includes(id));
  return id;
}
async function cashRecord(sql: Transaction, l: Ledger, id: string | null) {
  if (!id) return undefined;
  const [t] =
    await sql`SELECT * FROM transactions WHERE ledger_id=${l.id} AND id=${id}`;
  if (!t) throw new DomainError('not_found', 404);
  const entries =
    await sql`SELECT *,amount::text,exchange_rate::text,base_amount::text FROM transaction_entries WHERE ledger_id=${l.id} AND transaction_id=${id} ORDER BY entry_position`;
  return { ...t, entries } as unknown as TransactionRecord;
}
async function plan(sql: Transaction, l: Ledger, raw: unknown) {
  requireStockLedger(l);
  // Give the explicit ADR error before Zod's missing-field error.
  if (raw && typeof raw === 'object' && 'dividend' in raw)
    validateDividend((raw as { dividend: unknown }).dividend);
  const req = valid(dividendPreviewSchema, raw),
    old = req.id ? await get(sql, l.id, req.id) : undefined;
  const d = req.operation === 'delete' ? old! : validateDividend(req.dividend);
  const security = await readSecurity(sql, l.id, d.security_id);
  if (old && old.security_id !== d.security_id)
    throw new DomainError('invalid_input', 400);
  if (security.archived && req.operation === 'create')
    throw new DomainError('archived_resource', 400);
  lock(l, d.pay_date, ...(old ? [old.pay_date] : []));
  const resolved: {
      code: string;
      label: string;
      amount: string;
      taxable: boolean;
      income_item_id: string;
    }[] = [],
    legs = new Map<string, bigint>();
  const add = (id: string, n: bigint) => legs.set(id, (legs.get(id) ?? 0n) + n);
  const prior = await cashRecord(sql, l, old?.transaction_id ?? null),
    oldIds = prior?.entries.map((e) => e.item_id) ?? [];
  if (req.operation !== 'delete') {
    if (stockUnits(d.net_amount))
      add(
        await account(sql, l, d.settlement_item_id, 'asset', oldIds),
        stockUnits(d.net_amount),
      );
    for (const c of d.components) {
      const [code] =
        await sql`SELECT income_item_id FROM income_codes WHERE ledger_id=${l.id} AND code=${c.code}`;
      const item = await account(
        sql,
        l,
        code?.income_item_id ?? d.default_income_item_id,
        'income',
        oldIds,
      );
      resolved.push({ ...c, income_item_id: item });
      add(item, -stockUnits(c.amount));
    }
    const taxes = stockUnits(d.withholding_tax) + stockUnits(d.nhi_premium);
    if (taxes)
      add(await account(sql, l, d.tax_item_id, 'expense', oldIds), taxes);
    if (stockUnits(d.fee))
      add(
        await account(sql, l, d.expense_item_id, 'expense', oldIds),
        stockUnits(d.fee),
      );
  }
  const entries = [...legs]
    .filter(([, n]) => n !== 0n)
    .map(([item_id, n]) => ({ item_id, amount: stockFixed(n) }));
  const cash = entries.length
    ? await previewTransaction(
        sql,
        l,
        { occurred_on: d.pay_date, memo: d.note, entries },
        prior,
      )
    : null;
  const oldStock = old?.stock_trade_id ?? null,
    newStock = req.operation !== 'delete' && BigInt(d.stock_shares) > 0n;
  const stockOperation: 'create' | 'update' | 'delete' | null = oldStock
    ? newStock
      ? 'update'
      : 'delete'
    : newStock
      ? 'create'
      : null;
  const trade = {
    trade_type: 'stock_dividend' as const,
    trade_date: d.pay_date,
    quantity: d.stock_shares,
    note: d.note,
  };
  const stock = stockOperation
    ? await previewStockTrade(
        sql,
        l,
        d.security_id,
        {
          operation: stockOperation,
          ...(oldStock ? { trade_id: oldStock } : {}),
          ...(stockOperation !== 'delete' ? { trade } : {}),
        },
        true,
      )
    : null;
  const hash = createHash('sha256')
    .update(
      canonicalJson({
        req,
        old: old ?? null,
        resolved,
        entries,
        stock: stock?.preview_hash ?? null,
        lock: l.locked_until,
      }),
    )
    .digest('hex');
  return {
    req,
    d,
    old,
    resolved,
    entries,
    cash,
    stock,
    stockOperation,
    trade,
    hash,
  };
}
function publicPlan(p: Awaited<ReturnType<typeof plan>>) {
  return {
    preview_hash: p.hash,
    entries: p.cash?.entries ?? [],
    kind: p.cash?.kind ?? null,
    recalculations: p.stock?.recalculations ?? [],
    stock_trade: p.stock?.position ?? null,
  };
}
export function dividendService(db: Database) {
  const read = async <T>(
    actor: string,
    ledger: unknown,
    f: (sql: Transaction, l: Ledger) => Promise<T>,
  ) =>
    db.begin(async (sql) => {
      const l = await ownedLedger(sql, actor, valid(idSchema, ledger));
      requireStockLedger(l);
      return f(sql, l);
    });
  return {
    list(actor: string, ledger: unknown) {
      return read(actor, ledger, (sql, l) => rows(sql, l.id));
    },
    get(actor: string, ledger: unknown, id: unknown) {
      return read(actor, ledger, (sql, l) =>
        get(sql, l.id, valid(idSchema, id)),
      );
    },
    codes(actor: string, ledger: unknown) {
      return read(actor, ledger, async (sql, l) => ({
        disclaimer: incomeCodeDisclaimer,
        items:
          await sql`SELECT * FROM income_codes WHERE ledger_id=${l.id} ORDER BY code`,
      }));
    },
    initialize(actor: string, ledger: unknown) {
      return mutation(db, actor, 'income_code.initialize', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledger));
        requireStockLedger(l);
        async function ensure(kind: 'income' | 'expense', name: string) {
          const [old] =
            await sql`SELECT id FROM items WHERE ledger_id=${l.id} AND kind=${kind} AND name=${name} AND currency='TWD' AND non_operating AND NOT archived LIMIT 1`;
          if (old) return String(old.id);
          const [i] =
            await sql`INSERT INTO items(ledger_id,kind,name,currency,non_operating)VALUES(${l.id},${kind},${name},'TWD',true)RETURNING id`;
          await sql`INSERT INTO audit_logs(user_id,action,outcome)VALUES(${actor},'item.create','success')`;
          return String(i!.id);
        }
        const income = await ensure('income', '股利收入'),
          tax = await ensure('expense', '稅費'),
          fee = await ensure('expense', '投資費用');
        await sql`INSERT INTO income_codes(ledger_id,code,label,income_item_id)VALUES(${l.id},'54C','54C（範例，請依通知確認）',${income})ON CONFLICT(ledger_id,code)DO NOTHING`;
        return {
          default_income_item_id: income,
          tax_item_id: tax,
          expense_item_id: fee,
          disclaimer: incomeCodeDisclaimer,
        };
      });
    },
    saveCode(actor: string, ledger: unknown, id: unknown, input: unknown) {
      return mutation(
        db,
        actor,
        id ? 'income_code.update' : 'income_code.create',
        async (sql) => {
          const l = await ownedLedger(sql, actor, valid(idSchema, ledger));
          requireStockLedger(l);
          const d = valid(incomeCodeSchema, input);
          const [previous] = id
            ? await sql`SELECT income_item_id FROM income_codes WHERE ledger_id=${l.id} AND id=${valid(idSchema, id)}`
            : [];
          if (id && !previous) throw new DomainError('not_found', 404);
          if (d.income_item_id)
            await account(
              sql,
              l,
              d.income_item_id,
              'income',
              previous?.income_item_id ? [String(previous.income_item_id)] : [],
            );
          if (id) {
            const [r] =
              await sql`UPDATE income_codes SET ${sql(d)} WHERE ledger_id=${l.id} AND id=${valid(idSchema, id)} RETURNING *`;
            if (!r) throw new DomainError('not_found', 404);
            return r;
          }
          const [r] =
            await sql`INSERT INTO income_codes ${sql({ ...d, ledger_id: l.id })} RETURNING *`;
          return r!;
        },
      );
    },
    deleteCode(actor: string, ledger: unknown, id: unknown) {
      return mutation(db, actor, 'income_code.delete', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledger));
        requireStockLedger(l);
        const [r] =
          await sql`DELETE FROM income_codes WHERE ledger_id=${l.id} AND id=${valid(idSchema, id)} RETURNING id`;
        if (!r) throw new DomainError('not_found', 404);
      });
    },
    shares(actor: string, ledger: unknown, security: unknown, date: unknown) {
      return read(actor, ledger, async (sql, l) => {
        const sid = valid(idSchema, security),
          ex = valid(dateSchema, date);
        await readSecurity(sql, l.id, sid);
        const [r] =
          await sql`SELECT position_quantity::text quantity FROM security_trades WHERE ledger_id=${l.id} AND security_id=${sid} AND trade_date<${ex} ORDER BY trade_date DESC,sequence DESC LIMIT 1`;
        return { shares: r?.quantity ?? '0', ex_date: ex };
      });
    },
    preview(actor: string, ledger: unknown, input: unknown) {
      return read(actor, ledger, async (sql, l) =>
        publicPlan(await plan(sql, l, input)),
      );
    },
    apply(
      actor: string,
      ledger: unknown,
      operation: 'create' | 'update' | 'delete',
      input: unknown,
      id?: unknown,
    ) {
      return mutation(
        db,
        actor,
        operation === 'create'
          ? 'dividend.create'
          : operation === 'update'
            ? 'dividend.update'
            : 'dividend.delete',
        async (sql) => {
          const l = await ownedLedger(sql, actor, valid(idSchema, ledger));
          requireStockLedger(l);
          if (
            operation !== 'delete' &&
            input &&
            typeof input === 'object' &&
            'dividend' in input
          )
            validateDividend((input as { dividend: unknown }).dividend);
          const write = valid(
            operation === 'delete' ? dividendDeleteSchema : dividendWriteSchema,
            input,
          );
          const p = await plan(sql, l, {
            operation,
            ...(id ? { id: valid(idSchema, id) } : {}),
            ...('dividend' in write ? { dividend: write.dividend } : {}),
          });
          if (write.preview_hash !== p.hash)
            throw new DomainError('preview_changed', 409);
          if (p.stock?.recalculations.length && !write.confirm_recalculation)
            throw new DomainError('recalculation_confirmation_required', 409);
          const key = p.old?.id ?? randomUUID();
          let stockId = p.old?.stock_trade_id ?? null,
            tx = p.old?.transaction_id ?? null;
          if (p.stock && p.stockOperation) {
            const r = await applyStockTrade(
              sql,
              l,
              actor,
              p.d.security_id,
              p.stockOperation,
              {
                preview_hash: p.stock.preview_hash,
                confirm_recalculation: write.confirm_recalculation,
                ...(p.stockOperation !== 'delete' ? { trade: p.trade } : {}),
              },
              p.old?.stock_trade_id,
              true,
            );
            stockId = r.trade_id;
            await sql`INSERT INTO audit_logs(user_id,action,outcome)VALUES(${actor},${p.stockOperation === 'create' ? 'security.trade_create' : p.stockOperation === 'update' ? 'security.trade_update' : 'security.trade_delete'},'success')`;
          }
          if (operation === 'delete')
            await sql`DELETE FROM dividends WHERE ledger_id=${l.id} AND id=${key}`;
          if (p.cash) {
            if (tx) {
              await sql`UPDATE transactions SET occurred_on=${p.d.pay_date},memo=${p.d.note},kind=${p.cash.kind} WHERE ledger_id=${l.id} AND id=${tx}`;
              await saveTransactionEntries(sql, l.id, tx, p.cash.entries);
            } else
              tx = (
                await createTransaction(sql, l, {
                  occurred_on: p.d.pay_date,
                  memo: p.d.note,
                  entries: p.entries,
                })
              ).id;
          } else if (tx) {
            await sql`DELETE FROM transactions WHERE ledger_id=${l.id} AND id=${tx}`;
            tx = null;
          }
          if (operation === 'delete')
            return { id: key, deleted: true, ...publicPlan(p) };
          const { components: _, ...fields } = p.d;
          void _;
          const record = {
            ...fields,
            ledger_id: l.id,
            transaction_id: tx,
            stock_trade_id: stockId,
          };
          if (p.old) {
            await sql`UPDATE dividends SET ${sql(record)} WHERE ledger_id=${l.id} AND id=${key}`;
            await sql`DELETE FROM dividend_components WHERE dividend_id=${key} AND ledger_id=${l.id}`;
          } else
            await sql`INSERT INTO dividends ${sql({ id: key, ...record })}`;
          for (const c of p.resolved)
            await sql`INSERT INTO dividend_components ${sql({ ...c, dividend_id: key, ledger_id: l.id })}`;
          return get(sql, l.id, key);
        },
      );
    },
    report(actor: string, ledger: unknown, input: unknown = {}) {
      return read(actor, ledger, async (sql, l) => {
        const q = valid(dividendReportSchema, input);
        if (q.security_id) await readSecurity(sql, l.id, q.security_id);
        const all = await rows(sql, l.id);
        const filtered = all.filter(
          (d) =>
            (!q.date_from || d.pay_date >= q.date_from) &&
            (!q.date_to || d.pay_date <= q.date_to) &&
            (!q.security_id || d.security_id === q.security_id),
        );
        const codes = new Map<
          string,
          { code: string; amount: bigint; taxable_amount: bigint }
        >();
        for (const d of filtered)
          for (const c of d.components) {
            const r = codes.get(c.code) ?? {
              code: c.code,
              amount: 0n,
              taxable_amount: 0n,
            };
            r.amount += stockUnits(c.amount);
            if (c.taxable) r.taxable_amount += stockUnits(c.amount);
            codes.set(c.code, r);
          }
        const sum = (
          field:
            | 'gross_amount'
            | 'withholding_tax'
            | 'nhi_premium'
            | 'fee'
            | 'net_amount',
        ) =>
          stockFixed(filtered.reduce((n, d) => n + stockUnits(d[field]), 0n));
        return {
          report: 'dividends' as const,
          ledger_id: l.id,
          base_currency: l.base_currency,
          ...q,
          items: filtered,
          codes: [...codes.values()]
            .sort((a, b) => a.code.localeCompare(b.code))
            .map((c) => ({
              ...c,
              amount: stockFixed(c.amount),
              taxable_amount: stockFixed(c.taxable_amount),
            })),
          totals: {
            count: filtered.length,
            gross_amount: sum('gross_amount'),
            withholding_tax: sum('withholding_tax'),
            nhi_premium: sum('nhi_premium'),
            fee: sum('fee'),
            net_amount: sum('net_amount'),
          },
        };
      });
    },
  };
}
