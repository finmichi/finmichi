// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@finmichi/db';
import { taipeiToday } from '@finmichi/core';
import {
  stockUnits,
  stockFixed,
  stockDivide,
} from '@finmichi/core/securities-math';
import { ImportError } from './schema.js';
import { owner } from './import.js';
import type { Bundle } from './bundle.js';
import {
  transformInvestments,
  investmentMappingSchema,
  type InvestmentItem,
  type InvestmentPlan,
} from './investment-transform.js';
export interface InvestmentOptions {
  ownerSubject: string;
  ledgerId: string;
  apply?: boolean;
  mappingSha256?: string | null;
  now?: Date;
}
async function ledger(sql: Transaction, actor: string, id: string) {
  const [l] =
    await sql`SELECT id,base_currency FROM ledgers WHERE id=${id} AND owner_id=${actor} FOR UPDATE`;
  if (!l) throw new ImportError('not_found');
  if (l.base_currency !== 'TWD')
    throw new ImportError('securities_require_twd_ledger');
  return l;
}
async function reconciliation(sql: Transaction, id: string, p: InvestmentPlan) {
  const balances = await sql<
    { item_id: string; amount: string }[]
  >`SELECT item_id,sum(amount)::text amount FROM transaction_entries WHERE ledger_id=${id} GROUP BY item_id`;
  const balance = (id: string) =>
    stockUnits(balances.find((b) => b.item_id === id)?.amount ?? '0');
  const securities = p.securities.map((s) => {
    const rows = p.trades.filter((t) => t.security_id === s.id),
      last = rows.at(-1)!;
    return {
      symbol: s.symbol,
      quantity: last.position_quantity,
      cost: last.position_cost,
      average_cost:
        BigInt(last.position_quantity) === 0n
          ? '0.0000'
          : stockFixed(
              stockDivide(
                stockUnits(last.position_cost) * 100n,
                BigInt(last.position_quantity),
              ),
              4,
            ),
      linked: rows.filter((t) => t.source_transaction_id).length,
      unlinked: rows.filter((t) => !t.source_transaction_id).length,
    };
  });
  const cost = securities.reduce((n, s) => n + stockUnits(s.cost), 0n);
  return {
    securities,
    security_item: {
      item_id: p.securities_item,
      book_balance: stockFixed(balance(p.securities_item)),
      open_cost: stockFixed(cost),
      difference: stockFixed(balance(p.securities_item) - cost),
      possible_causes: {
        separate_fee: p.trades.filter((t) => stockUnits(t.fee) > 0n).length,
        unlinked: p.trades.filter((t) => !t.source_transaction_id).length,
        stock_amount_mismatch: p.warnings.filter(
          (w) => w.code === 'stock_amount_mismatch',
        ).length,
      },
    },
    deposits: [...new Set(p.deposits.map((d) => d.item_id))].map((item) => {
      const principal = p.deposits
        .filter((d) => d.item_id === item && d.status === 'active')
        .reduce((n, d) => n + stockUnits(d.principal), 0n);
      return {
        item_id: item,
        book_balance: stockFixed(balance(item)),
        active_principal: stockFixed(principal),
        difference: stockFixed(balance(item) - principal),
      };
    }),
  };
}
export async function importInvestments(
  db: Database,
  bundle: Bundle,
  rawMapping: unknown,
  options: InvestmentOptions,
) {
  const actor = await owner(db, options.ownerSubject);
  try {
    return await db.begin(async (sql) => {
      await ledger(sql, actor, options.ledgerId);
      const id = options.ledgerId;
      if (
        !(
          await sql`SELECT id FROM import_jobs WHERE ledger_id=${id} AND source_sha256=${bundle.sourceSha256} AND source_system='emoney-mdb' AND kind='ledger' AND status='imported'`
        ).length
      )
        throw new ImportError('source_mismatch');
      if (
        (
          await sql`SELECT id FROM import_jobs WHERE ledger_id=${id} AND source_sha256=${bundle.sourceSha256} AND kind='emoney-investments' AND status='imported'`
        ).length
      )
        throw new ImportError('already_imported');
      const parsed = investmentMappingSchema.safeParse(rawMapping);
      if (!parsed.success)
        throw new ImportError('mapping_invalid', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        });
      const mapping = parsed.data;
      const items = await sql<
        InvestmentItem[]
      >`SELECT * FROM items WHERE ledger_id=${id}`;
      const markets = await sql<
        { symbol: string; market: 'TWSE' | 'TPEx'; trade_date: string }[]
      >`SELECT DISTINCT ON(market,symbol) symbol,market,trade_date::text FROM market_prices ORDER BY market,symbol,trade_date DESC`;
      const transactions = await sql<
        { id: string; source_id: string | null }[]
      >`SELECT id,source_id FROM transactions WHERE ledger_id=${id} AND source_system='emoney-mdb'`;
      const revoked = await sql<{ report: { created_item_ids?: unknown } }[]>`
        SELECT report FROM import_jobs WHERE ledger_id=${id}
        AND source_system='emoney-mdb' AND kind='emoney-investments'
        AND status='validated' AND report->>'reverted'='true'`;
      const reusableItemIds = revoked.flatMap(({ report }) =>
        Array.isArray(report.created_item_ids)
          ? report.created_item_ids.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
      );
      const p = transformInvestments(bundle, mapping, {
        items,
        reusableItemIds,
        markets,
        transactions,
        today: taipeiToday(options.now),
      });
      if (
        (
          await sql`SELECT id FROM securities WHERE ledger_id=${id} AND item_id=${p.securities_item}`
        ).length
      )
        throw new ImportError('mapping_item_invalid', {
          reason: 'securities_item_already_used',
        });
      const result = {
        dry_run: !options.apply,
        source_sha256: bundle.sourceSha256,
        mapping_sha256: options.mappingSha256 ?? null,
        counts: {
          securities: p.securities.length,
          trades: p.trades.length,
          deposits: p.deposits.length,
        },
        warnings: p.warnings,
        suggested_deposit_mapping: p.suggested_deposit_mapping,
        reconciliation: await reconciliation(sql, id, p),
      };
      if (!options.apply) return { ...result, import_job_id: null };
      const job = randomUUID();
      // Keep private amounts, names, source rows and reconciliation exclusively in the local report.
      const report = {
        mapping_sha256: options.mappingSha256 ?? null,
        created_item_ids: p.created_items.map((item) => item.id),
        counts: result.counts,
        securities_item: p.securities_item,
        previous_securities: p.previous_securities,
        warning_counts: Object.fromEntries(
          [...new Set(p.warnings.map((w) => w.code))].map((code) => [
            code,
            p.warnings.filter((w) => w.code === code).length,
          ]),
        ),
      };
      await sql`INSERT INTO import_jobs(id,ledger_id,source_sha256,source_system,kind,status,report) VALUES(${job},${id},${bundle.sourceSha256},'emoney-mdb','emoney-investments','validated',${sql.json(report)})`;
      for (const item of p.created_items)
        await sql`INSERT INTO items ${sql({ ...item, ledger_id: id })}`;
      await sql`UPDATE items SET securities=true WHERE id=${p.securities_item} AND ledger_id=${id}`;
      const source = async (
        table: string,
        key: string,
        target: string,
        targetId: string,
      ) => {
        await sql`INSERT INTO import_source_records(ledger_id,import_job_id,source_table,source_key,target_table,target_id) VALUES(${id},${job},${table},${key},${target},${targetId})`;
      };
      for (const { source_key, ...s } of p.securities) {
        await sql`INSERT INTO securities ${sql({ ...s, ledger_id: id })}`;
        await source('STOCK_ID_DATA', source_key, 'securities', s.id);
      }
      for (const { source_key, ...t } of p.trades) {
        await sql`INSERT INTO security_trades ${sql({ ...t, ledger_id: id })}`;
        await source('STOCK_DATA', source_key, 'security_trades', t.id);
      }
      for (const { source_key, ...d } of p.deposits) {
        await sql`INSERT INTO fixed_deposits ${sql({ ...d, ledger_id: id })}`;
        await source('REGULAR_DATA', source_key, 'fixed_deposits', d.id);
      }
      await sql`UPDATE import_jobs SET status='imported' WHERE id=${job}`;
      await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES(${actor},'emoney.import_investments','success')`;
      return { ...result, import_job_id: job };
    });
  } catch (e) {
    if (options.apply)
      await db`INSERT INTO audit_logs(user_id,action,outcome) VALUES(${actor},'emoney.import_investments','error')`;
    throw e;
  }
}
export async function revertInvestments(
  db: Database,
  jobId: string,
  options: InvestmentOptions,
) {
  const actor = await owner(db, options.ownerSubject);
  try {
    return await db.begin(async (sql) => {
      await ledger(sql, actor, options.ledgerId);
      const id = options.ledgerId;
      const [job] =
        await sql`SELECT id,report FROM import_jobs WHERE id=${jobId} AND ledger_id=${id} AND kind='emoney-investments' AND status='imported' FOR UPDATE`;
      if (!job) throw new ImportError('not_found');
      const refs = await sql<
        { target_table: string; target_id: string }[]
      >`SELECT target_table,target_id FROM import_source_records WHERE ledger_id=${id} AND import_job_id=${jobId}`;
      const ids = (table: string) =>
        refs
          .filter(
            (r) =>
              r.target_table === table && !r.target_id.startsWith('deleted:'),
          )
          .map((r) => r.target_id);
      const securities = ids('securities'),
        deposits = ids('fixed_deposits'),
        reasons: string[] = [];
      if (securities.length) {
        if (
          (
            await sql`SELECT 1 FROM security_trades WHERE ledger_id=${id} AND security_id IN ${sql(securities)} AND origin='app' LIMIT 1`
          ).length
        )
          reasons.push('app_trades');
        if (
          (
            await sql`SELECT 1 FROM dividends WHERE ledger_id=${id} AND security_id IN ${sql(securities)} LIMIT 1`
          ).length
        )
          reasons.push('dividends');
      }
      if (deposits.length) {
        if (
          (
            await sql`SELECT 1 FROM deposit_postings WHERE ledger_id=${id} AND deposit_id IN ${sql(deposits)} LIMIT 1`
          ).length
        )
          reasons.push('deposit_postings');
        if (
          (
            await sql`SELECT 1 FROM fixed_deposits WHERE ledger_id=${id} AND (renewed_from_id IN ${sql(deposits)} OR id IN ${sql(deposits)} AND renewed_from_id IS NOT NULL) LIMIT 1`
          ).length
        )
          reasons.push('deposit_renewal');
      }
      if (reasons.length) throw new ImportError('revert_blocked', { reasons });
      const report = job.report as {
        securities_item: string;
        previous_securities: boolean;
      };
      if (
        (
          await sql`SELECT 1 FROM securities WHERE ledger_id=${id} AND item_id=${report.securities_item} AND NOT(id=ANY(${sql.array(securities)}::uuid[])) LIMIT 1`
        ).length &&
        !report.previous_securities
      )
        throw new ImportError('revert_blocked', {
          reasons: ['securities_item_in_use'],
        });
      if (!options.apply) return { dry_run: true, revert_job_id: jobId };
      if (securities.length) {
        await sql`DELETE FROM security_trades WHERE ledger_id=${id} AND security_id IN ${sql(securities)}`;
        await sql`DELETE FROM securities WHERE ledger_id=${id} AND id IN ${sql(securities)}`;
      }
      if (deposits.length)
        await sql`DELETE FROM fixed_deposits WHERE ledger_id=${id} AND id IN ${sql(deposits)}`;
      await sql`UPDATE items SET securities=${report.previous_securities} WHERE ledger_id=${id} AND id=${report.securities_item}`;
      await sql`DELETE FROM import_source_records WHERE ledger_id=${id} AND import_job_id=${jobId}`;
      // Keep a metadata-only tombstone: an imported job alone never permits create reuse.
      await sql`UPDATE import_jobs SET status='validated',report=report || '{"reverted":true}'::jsonb WHERE ledger_id=${id} AND id=${jobId}`;
      await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES(${actor},'emoney.import_investments','success')`;
      return { dry_run: false, reverted_job_id: jobId };
    });
  } catch (e) {
    if (options.apply)
      await db`INSERT INTO audit_logs(user_id,action,outcome) VALUES(${actor},'emoney.import_investments','error')`;
    throw e;
  }
}
