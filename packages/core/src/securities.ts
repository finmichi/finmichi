// SPDX-License-Identifier: AGPL-3.0-only
import { assertPostableItem } from './postable.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, ownedLedger, valid, mutation } from './catalog.js';
import { idSchema, type Ledger, type Item } from './catalog-schemas.js';
import {
  createTransaction,
  previewTransaction,
  saveTransactionEntries,
} from './transactions.js';
import type { TransactionRecord, Preview } from './transaction-schemas.js';
import { canonicalJson } from './backups.js';
import {
  securitySchema,
  securityUpdateSchema,
  stockPreviewSchema,
  stockWriteSchema,
  stockDeleteSchema,
  manualPriceSchema,
  type Security,
} from './securities-schemas.js';
import {
  replayStocks,
  stockValues,
  stockUnits,
  stockFixed,
  StockCalculationError,
  type ReplayTrade,
  type StockStep,
} from './securities-math.js';
export interface TradeRow extends ReplayTrade {
  origin: 'app' | 'emoney';
  source_transaction_id: string | null;
  ledger_id: string;
  security_id: string;
  transaction_id: string | null;
  note: string;
  settlement_item_id: string | null;
  expense_item_id: string | null;
  gain_item_id: string | null;
  gross: string;
  cost_removed: string;
  position_quantity: string;
  position_cost: string;
  realized_gain: string;
}
export function requireStockLedger(l: Ledger) {
  if (l.base_currency !== 'TWD')
    throw new DomainError('securities_require_twd_ledger', 400);
}
export async function readSecurity(
  sql: Transaction,
  ledger: string,
  id: string,
): Promise<Security> {
  const [r] = await sql<
    Security[]
  >`SELECT * FROM securities WHERE ledger_id=${ledger} AND id=${valid(idSchema, id)}`;
  if (!r) throw new DomainError('not_found', 404);
  return r;
}
export async function readTrades(
  sql: Transaction,
  ledger: string,
  security: string,
) {
  return sql<
    TradeRow[]
  >`SELECT *,trade_date::text,quantity::text,quantity_after::text,price::text,fee::text,tax::text,cost_after::text,cash_amount::text,gross::text,cost_removed::text,position_quantity::text,position_cost::text,realized_gain::text FROM security_trades t WHERE ledger_id=${ledger} AND security_id=${security} ORDER BY t.trade_date,t.sequence`;
}
async function account(
  sql: Transaction,
  ledger: string,
  id: string | null,
  kind: Item['kind'],
  flagged: boolean,
  old?: string | null,
) {
  if (!id) throw new DomainError('security_account_required', 400);
  const [r] = await sql<
    Item[]
  >`SELECT * FROM items WHERE ledger_id=${ledger} AND id=${id}`;
  if (!r) throw new DomainError('not_found', 404);
  if (
    r.currency !== 'TWD' ||
    r.kind !== kind ||
    (kind === 'asset' ? Boolean(r.securities) !== flagged : !r.non_operating)
  )
    throw new DomainError('security_account_invalid', 400);
  if (r.archived && old !== id) throw new DomainError('archived_resource', 400);
  await assertPostableItem(sql, ledger, id, old === id);
  return r;
}
async function oldTransactions(
  sql: Transaction,
  ledger: string,
  security: string,
) {
  const rows = await sql<
    Omit<TransactionRecord, 'entries'>[]
  >`SELECT t.id,t.ledger_id,t.occurred_on::text,t.memo,t.payee_id,t.project_id,t.invoice_no,t.kind FROM transactions t JOIN security_trades s ON s.transaction_id=t.id AND s.ledger_id=t.ledger_id WHERE s.ledger_id=${ledger} AND s.security_id=${security}`;
  const entries = await sql<
    (TransactionRecord['entries'][number] & { transaction_id: string })[]
  >`SELECT e.id,e.transaction_id,e.item_id,e.amount::text,e.currency,e.exchange_rate::text,e.base_amount::text,e.entry_position FROM transaction_entries e JOIN security_trades s ON s.transaction_id=e.transaction_id AND s.ledger_id=e.ledger_id WHERE s.ledger_id=${ledger} AND s.security_id=${security} ORDER BY e.entry_position`;
  const grouped = new Map<string, TransactionRecord['entries']>();
  for (const e of entries) {
    const group = grouped.get(e.transaction_id) ?? [];
    group.push(e);
    grouped.set(e.transaction_id, group);
  }
  return new Map(
    rows.map((r) => [r.id, { ...r, entries: grouped.get(r.id) ?? [] }]),
  );
}
export interface StockLeg {
  item_id: string;
  amount: string;
  position: number;
}
function legs(s: Security, t: TradeRow, step: StockStep): StockLeg[] {
  const result: StockLeg[] = [];
  const add = (id: string | null, n: bigint, position: number) => {
    if (n) {
      if (!id) throw new DomainError('security_account_required', 400);
      result.push({ item_id: id, amount: stockFixed(n), position });
    }
  };
  const change = stockUnits(step.cost_after) - stockUnits(step.cost_before),
    fee = stockUnits(t.fee) + stockUnits(t.tax);
  if (t.trade_type === 'buy') {
    add(t.settlement_item_id, -change, 0);
    add(s.item_id, change, 1);
  } else if (t.trade_type === 'sell') {
    add(t.settlement_item_id, stockUnits(step.gross) - fee, 0);
    add(s.item_id, change, 1);
    add(t.expense_item_id, fee, 2);
    add(t.gain_item_id, -stockUnits(step.gain_before_fees), 3);
  } else if (t.trade_type === 'adjust' && t.cost_mode !== 'keep') {
    if (t.cost_mode === 'cash_return')
      add(t.settlement_item_id, stockUnits(t.cash_amount!), 0);
    add(s.item_id, change, 1);
    add(t.gain_item_id, -stockUnits(step.realized_gain), 3);
  }
  return result;
}
function sameEntries(old: TransactionRecord | undefined, next: StockLeg[]) {
  const shape = (
    rows: { item_id: string; amount: string; entry_position: number }[],
  ) =>
    rows
      .map((r) => [
        r.item_id,
        stockFixed(stockUnits(r.amount)),
        r.entry_position,
      ])
      .sort((a, b) => Number(a[2]) - Number(b[2]));
  return (
    canonicalJson(shape(old?.entries ?? [])) ===
    canonicalJson(
      shape(next.map((r) => ({ ...r, entry_position: r.position }))),
    )
  );
}
const provisionalId = '00000000-0000-4000-8000-000000000001';
type Operation = 'create' | 'update' | 'delete';
async function plan(
  sql: Transaction,
  l: Ledger,
  securityId: string,
  input: unknown,
  managedDividend = false,
) {
  requireStockLedger(l);
  const req = valid(stockPreviewSchema, input),
    security = await readSecurity(sql, l.id, securityId),
    before = await readTrades(sql, l.id, securityId),
    old = req.trade_id ? before.find((r) => r.id === req.trade_id) : undefined;
  if (req.trade_id && !old) throw new DomainError('not_found', 404);
  if (
    old &&
    !managedDividend &&
    (
      await sql`SELECT 1 FROM dividends WHERE ledger_id=${l.id} AND stock_trade_id=${old.id}`
    ).length
  )
    throw new DomainError('dividend_managed_trade', 409);
  if (security.archived && req.operation === 'create')
    throw new DomainError('archived_resource', 400);
  const holding = await account(
    sql,
    l.id,
    security.item_id,
    'asset',
    true,
    old ? security.item_id : undefined,
  );
  const existingIds = new Set(before.map((r) => r.id));
  let targetId = old?.id ?? provisionalId;
  for (let n = 2; !old && existingIds.has(targetId); n++)
    targetId = '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
  const rows: TradeRow[] = before
    .filter((r) => r.id !== old?.id)
    .map((r) => ({ ...r }));
  let target: TradeRow | undefined;
  if (req.operation !== 'delete') {
    const d = req.trade!;
    if (old?.origin === 'emoney' && d.trade_type !== old.trade_type)
      throw new DomainError('emoney_trade_type_locked', 400);
    const sameDay = rows
        .filter((r) => r.trade_date === d.trade_date)
        .sort((a, b) => a.sequence - b.sequence),
      sequence =
        d.sequence ??
        (old?.trade_date === d.trade_date ? old.sequence : sameDay.length + 1);
    if (sequence > sameDay.length + 1)
      throw new DomainError('invalid_sequence', 400);
    for (let i = 0; i < sameDay.length; i++)
      sameDay[i]!.sequence = i >= sequence - 1 ? i + 2 : i + 1;
    target = {
      ...stockValues(d),
      id: targetId,
      ledger_id: l.id,
      security_id: securityId,
      trade_date: d.trade_date,
      sequence,
      note: d.note,
      settlement_item_id: d.settlement_item_id,
      expense_item_id: d.expense_item_id,
      gain_item_id: d.gain_item_id,
      origin: old?.origin ?? 'app',
      source_transaction_id: old?.source_transaction_id ?? null,
      transaction_id: old?.transaction_id ?? null,
      gross: '0.00',
      cost_removed: '0.00',
      position_quantity: '0',
      position_cost: '0.00',
      realized_gain: '0.00',
    };
    if (
      d.trade_type === 'buy' ||
      d.trade_type === 'sell' ||
      (d.trade_type === 'adjust' && d.cost_mode === 'cash_return')
    )
      await account(
        sql,
        l.id,
        d.settlement_item_id,
        'asset',
        false,
        old?.settlement_item_id,
      );
    if (d.trade_type === 'sell')
      await account(
        sql,
        l.id,
        d.expense_item_id,
        'expense',
        false,
        old?.expense_item_id,
      );
    if (
      d.trade_type === 'sell' ||
      (d.trade_type === 'adjust' && d.cost_mode !== 'keep')
    )
      await account(
        sql,
        l.id,
        d.gain_item_id,
        'income',
        false,
        old?.gain_item_id,
      );
    rows.push(target);
  }
  // Normalize only the old day after removing/moving a trade; explicit ordering is stable in backups.
  if (old && (!target || target.trade_date !== old.trade_date))
    rows
      .filter((r) => r.trade_date === old.trade_date)
      .sort((a, b) => a.sequence - b.sequence)
      .forEach((r, i) => (r.sequence = i + 1));
  const blocked = [old?.trade_date, target?.trade_date].filter(
    (d): d is string => !!d && !!l.locked_until && d <= l.locked_until,
  );
  if (blocked.length) {
    const first = [old?.trade_date, target?.trade_date]
      .filter((v): v is string => !!v)
      .sort()[0]!;
    blocked.push(
      ...before
        .filter(
          (t) =>
            t.transaction_id &&
            t.trade_date >= first &&
            t.trade_date <= l.locked_until!,
        )
        .map((t) => t.trade_date),
    );
  }
  if (blocked.length)
    throw new DomainError('period_locked', 409, {
      affected_dates: [...new Set(blocked)].sort(),
    });
  let steps: StockStep[];
  try {
    steps = replayStocks(rows);
  } catch (e) {
    if (e instanceof StockCalculationError)
      throw new DomainError(
        e.code,
        e.code === 'insufficient_shares' ? 409 : 400,
        e.details,
      );
    throw e;
  }
  const stepMap = new Map(steps.map((s) => [s.trade_id, s])),
    transactions = await oldTransactions(sql, l.id, securityId),
    calculations = new Map<
      string,
      { entries: StockLeg[]; calc: Preview | null }
    >(),
    affected: {
      trade_id: string;
      transaction_id: string | null;
      trade_date: string;
      trade_type: string;
      old_gain: string;
      new_gain: string;
      old_cost: string;
      new_cost: string;
    }[] = [];
  for (const t of rows) {
    const step = stepMap.get(t.id)!,
      entries = t.origin === 'emoney' ? [] : legs(security, t, step),
      prior = t.transaction_id ? transactions.get(t.transaction_id) : undefined,
      isTarget = t.id === targetId;
    const changed =
      t.origin === 'emoney'
        ? t.cost_removed !== step.cost_removed ||
          t.realized_gain !== step.realized_gain ||
          t.position_cost !== step.cost_after ||
          t.position_quantity !== step.quantity_after
        : !sameEntries(prior, entries);
    if (!isTarget && changed) {
      if (l.locked_until && t.trade_date <= l.locked_until)
        throw new DomainError('period_locked', 409, {
          affected_dates: [t.trade_date],
        });
      affected.push({
        trade_id: t.id,
        transaction_id: t.transaction_id,
        trade_date: t.trade_date,
        trade_type: t.trade_type,
        old_gain: t.realized_gain,
        new_gain: step.realized_gain,
        old_cost: t.cost_removed,
        new_cost: step.cost_removed,
      });
    }
    let calc: Preview | null = null;
    if (
      t.origin === 'app' &&
      (entries.length || t.trade_type === 'buy' || t.trade_type === 'sell') &&
      (isTarget || changed)
    )
      calc = await previewTransaction(
        sql,
        l,
        {
          occurred_on: t.trade_date,
          memo: t.note,
          entries: entries.map((e) => ({
            item_id: e.item_id,
            amount: e.amount,
          })),
        },
        prior,
        true,
        !isTarget,
      );
    calculations.set(t.id, { entries, calc });
  }
  const hash = createHash('sha256')
    .update(
      canonicalJson({
        req,
        before,
        lock: l.locked_until,
        steps,
        holding: holding.id,
      }),
    )
    .digest('hex');
  return {
    req,
    security,
    before,
    rows,
    targetId,
    steps,
    stepMap,
    transactions,
    calculations,
    affected,
    hash,
  };
}
function publicPlan(p: Awaited<ReturnType<typeof plan>>) {
  const selected = p.stepMap.get(p.targetId),
    calc = p.calculations.get(p.targetId)?.calc;
  return {
    preview_hash: p.hash,
    operation: p.req.operation,
    position: selected ?? p.steps.at(-1) ?? null,
    entries: calc?.entries ?? [],
    kind: calc?.kind ?? null,
    recalculations: p.affected,
  };
}
async function fixedPositions(
  sql: Transaction,
  ledger: string,
  tx: string,
  entries: StockLeg[],
) {
  await sql`UPDATE transaction_entries SET entry_position=entry_position+100 WHERE ledger_id=${ledger} AND transaction_id=${tx}`;
  for (const e of entries)
    await sql`UPDATE transaction_entries SET entry_position=${e.position} WHERE ledger_id=${ledger} AND transaction_id=${tx} AND item_id=${e.item_id}`;
}
function cached(step: StockStep) {
  return {
    gross: step.gross,
    cost_removed: step.cost_removed,
    position_quantity: step.quantity_after,
    position_cost: step.cost_after,
    realized_gain: step.realized_gain,
  };
}
export async function applyStockTrade(
  sql: Transaction,
  l: Ledger,
  actor: string,
  securityId: unknown,
  operation: Operation,
  input: unknown,
  tradeId?: unknown,
  managedDividend = false,
) {
  requireStockLedger(l);
  const write =
    operation === 'delete'
      ? valid(stockDeleteSchema, input)
      : valid(stockWriteSchema, input);
  const p = await plan(
    sql,
    l,
    valid(idSchema, securityId),
    {
      operation,
      ...(operation !== 'create' ? { trade_id: valid(idSchema, tradeId) } : {}),
      ...('trade' in write ? { trade: write.trade } : {}),
    },
    managedDividend,
  );
  if (write.preview_hash !== p.hash)
    throw new DomainError('preview_changed', 409);
  if (p.affected.length && !write.confirm_recalculation)
    throw new DomainError('recalculation_confirmation_required', 409);
  const id = operation === 'create' ? randomUUID() : p.targetId,
    affectedIds = new Set(p.affected.map((r) => r.trade_id));
  const originalById = new Map(p.before.map((r) => [r.id, r]));
  const deleted = originalById.get(p.targetId);
  if (operation === 'delete') {
    await sql`DELETE FROM security_trades WHERE ledger_id=${l.id} AND id=${p.targetId}`;
    if (deleted?.transaction_id) {
      await sql`UPDATE import_source_records SET target_id='deleted:'||target_id WHERE ledger_id=${l.id} AND target_table='transactions' AND lower(target_id)=${deleted.transaction_id}`;
      await sql`DELETE FROM transactions WHERE ledger_id=${l.id} AND id=${deleted.transaction_id}`;
    }
  }
  for (const t of p.rows) {
    const isTarget = t.id === p.targetId,
      step = p.stepMap.get(t.id)!,
      c = p.calculations.get(t.id)!,
      prior = t.transaction_id
        ? p.transactions.get(t.transaction_id)
        : undefined;
    let tx = t.transaction_id;
    if (isTarget || affectedIds.has(t.id)) {
      if (c.calc) {
        if (!tx)
          tx = (
            await createTransaction(
              sql,
              l,
              {
                occurred_on: t.trade_date,
                memo: t.note,
                entries: c.entries.map((e) => ({
                  item_id: e.item_id,
                  amount: e.amount,
                })),
              },
              true,
              !isTarget,
            )
          ).id;
        else if (isTarget) {
          await sql`UPDATE transactions SET occurred_on=${t.trade_date},memo=${t.note},kind=${c.calc.kind} WHERE id=${tx} AND ledger_id=${l.id}`;
          await saveTransactionEntries(sql, l.id, tx, c.calc.entries);
        } else {
          // Actual cash and fee rows (including their IDs/positions) are never replaced by replay.
          await sql`DELETE FROM transaction_entries WHERE ledger_id=${l.id} AND transaction_id=${tx} AND item_id IN (${p.security.item_id},${t.gain_item_id})`;
          for (const e of c.entries.filter(
            (e) => e.position === 1 || e.position === 3,
          ))
            await sql`INSERT INTO transaction_entries(ledger_id,transaction_id,item_id,amount,currency,exchange_rate,base_amount,entry_position) VALUES(${l.id},${tx},${e.item_id},${e.amount},'TWD',1,${e.amount},${e.position})`;
          await sql`UPDATE transactions SET kind=${c.calc.kind} WHERE ledger_id=${l.id} AND id=${tx}`;
        }
        if (isTarget || !prior) await fixedPositions(sql, l.id, tx, c.entries);
      } else if (tx) {
        await sql`UPDATE import_source_records SET target_id='deleted:'||target_id WHERE ledger_id=${l.id} AND target_table='transactions' AND lower(target_id)=${tx}`;
        await sql`DELETE FROM transactions WHERE id=${tx} AND ledger_id=${l.id}`;
        tx = null;
      }
      if (!isTarget)
        await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES(${actor},'security.recalculate','success')`;
    }
    const fields = {
      origin: t.origin,
      source_transaction_id: t.source_transaction_id,
      security_id: t.security_id,
      ledger_id: l.id,
      trade_type: t.trade_type,
      trade_date: t.trade_date,
      sequence: t.sequence,
      quantity: t.quantity,
      quantity_after: t.quantity_after,
      price: t.price,
      fee: t.fee,
      tax: t.tax,
      cost_mode: t.cost_mode,
      cost_after: t.cost_after,
      cash_amount: t.cash_amount,
      note: t.note,
      settlement_item_id: t.settlement_item_id,
      expense_item_id: t.expense_item_id,
      gain_item_id: t.gain_item_id,
      transaction_id: tx,
      ...cached(step),
    };
    const original = originalById.get(t.id);
    if (
      !isTarget &&
      original &&
      Object.entries(fields).every(
        ([key, value]) => original[key as keyof TradeRow] === value,
      )
    )
      continue;
    if (isTarget && operation === 'create')
      await sql`INSERT INTO security_trades ${sql({ id, ...fields })}`;
    else
      await sql`UPDATE security_trades SET ${sql(fields)} WHERE ledger_id=${l.id} AND id=${t.id}`;
  }
  const result = publicPlan(p);
  if (operation !== 'delete' && result.position?.trade_id === p.targetId)
    result.position = { ...result.position, trade_id: id };
  return { ...result, trade_id: operation === 'delete' ? null : id };
}
export async function previewStockTrade(
  sql: Transaction,
  l: Ledger,
  securityId: string,
  input: unknown,
  managedDividend = false,
) {
  return publicPlan(await plan(sql, l, securityId, input, managedDividend));
}
export function securityService(db: Database) {
  const read = async <T>(
    actor: string,
    ledgerId: unknown,
    f: (sql: Transaction, l: Ledger) => Promise<T>,
  ) =>
    db.begin(async (sql) => {
      const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId), false);
      return f(sql, l);
    });
  return {
    async list(actor: string, ledgerId: unknown) {
      return read(
        actor,
        ledgerId,
        async (sql, l) =>
          sql<
            Security[]
          >`SELECT * FROM securities WHERE ledger_id=${l.id} ORDER BY market,symbol,item_id`,
      );
    },
    async get(actor: string, ledgerId: unknown, securityId: unknown) {
      return read(actor, ledgerId, async (sql, l) =>
        readSecurity(sql, l.id, valid(idSchema, securityId)),
      );
    },
    async create(actor: string, ledgerId: unknown, input: unknown) {
      return mutation(db, actor, 'security.create', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId));
        requireStockLedger(l);
        const d = valid(securitySchema, input);
        await account(sql, l.id, d.item_id, 'asset', true);
        const [r] = await sql<
          Security[]
        >`INSERT INTO securities ${sql({ ...d, ledger_id: l.id })} RETURNING *`;
        return r!;
      });
    },
    async update(
      actor: string,
      ledgerId: unknown,
      securityId: unknown,
      input: unknown,
    ) {
      return mutation(db, actor, 'security.update', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId));
        requireStockLedger(l);
        const id = valid(idSchema, securityId),
          old = await readSecurity(sql, l.id, id),
          d = valid(securityUpdateSchema, input);
        if (
          ['symbol', 'market', 'kind', 'item_id'].some(
            (k) =>
              k in d && d[k as keyof typeof d] !== old[k as keyof Security],
          ) &&
          (
            await sql`SELECT 1 FROM security_trades WHERE security_id=${id} LIMIT 1`
          ).length
        )
          throw new DomainError('in_use', 409);
        await account(
          sql,
          l.id,
          d.item_id ?? old.item_id,
          'asset',
          true,
          old.item_id,
        );
        const [r] = await sql<
          Security[]
        >`UPDATE securities SET ${sql(d)} WHERE ledger_id=${l.id} AND id=${id} RETURNING *`;
        return r!;
      });
    },
    async remove(actor: string, ledgerId: unknown, securityId: unknown) {
      return mutation(db, actor, 'security.delete', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId));
        requireStockLedger(l);
        const id = valid(idSchema, securityId);
        await readSecurity(sql, l.id, id);
        if (
          (
            await sql`SELECT 1 FROM security_trades WHERE security_id=${id} LIMIT 1`
          ).length
        )
          throw new DomainError('in_use', 409);
        await sql`DELETE FROM securities WHERE ledger_id=${l.id} AND id=${id}`;
      });
    },
    async preview(
      actor: string,
      ledgerId: unknown,
      securityId: unknown,
      input: unknown,
    ) {
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId));
        return publicPlan(
          await plan(sql, l, valid(idSchema, securityId), input),
        );
      });
    },
    async apply(
      actor: string,
      ledgerId: unknown,
      securityId: unknown,
      operation: Operation,
      input: unknown,
      tradeId?: unknown,
    ) {
      return mutation(
        db,
        actor,
        operation === 'create'
          ? 'security.trade_create'
          : operation === 'update'
            ? 'security.trade_update'
            : 'security.trade_delete',
        async (sql) => {
          const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId));
          return applyStockTrade(
            sql,
            l,
            actor,
            securityId,
            operation,
            input,
            tradeId,
          );
        },
      );
    },
    async price(actor: string, ledgerId: unknown, input: unknown) {
      return mutation(db, actor, 'security.price_update', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId));
        requireStockLedger(l);
        const d = valid(manualPriceSchema, input);
        if (
          !(
            await sql`SELECT id FROM securities WHERE ledger_id=${l.id} AND market=${d.market} AND symbol=${d.symbol} LIMIT 1`
          ).length
        )
          throw new DomainError('not_found', 404);
        const [r] =
          await sql`INSERT INTO manual_prices ${sql({ ...d, ledger_id: l.id })} ON CONFLICT(ledger_id,market,symbol,price_date) DO UPDATE SET price=EXCLUDED.price RETURNING id,ledger_id,market,symbol,price_date::text,price::text`;
        return r!;
      });
    },
    async removePrice(actor: string, ledgerId: unknown, id: unknown) {
      return mutation(db, actor, 'security.price_delete', async (sql) => {
        const l = await ownedLedger(sql, actor, valid(idSchema, ledgerId));
        requireStockLedger(l);
        const [r] =
          await sql`DELETE FROM manual_prices WHERE ledger_id=${l.id} AND id=${valid(idSchema, id)} RETURNING id`;
        if (!r) throw new DomainError('not_found', 404);
      });
    },
  };
}
