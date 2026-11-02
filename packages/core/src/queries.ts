// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, ownedLedger, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import { dateSchema } from './transaction-schemas.js';
import {
  filterSchema,
  querySchema,
  summarySchema,
  type QueryFilter,
  type QueryInput,
  type QueryRow,
  type QueryTotals,
  type QueryPage,
  type QuerySummary,
  type ItemSummary,
  type MonthSummary,
} from './query-schemas.js';
const cursorSchema = z.strictObject({
  v: z.literal(1),
  filter: z.string().regex(/^[a-f0-9]{64}$/),
  date: dateSchema,
  created_at: z.iso.datetime({ precision: 6 }),
  id: idSchema,
});
const keys = [
  'date_from',
  'date_to',
  'item_id',
  'project_id',
  'payee_id',
  'keyword',
  'amount_min',
  'amount_max',
  'kind',
] as const;
function filterKey(actor: string, ledger: string, q: QueryFilter) {
  return createHash('sha256')
    .update(JSON.stringify([actor, ledger, ...keys.map((k) => q[k] ?? null)]))
    .digest('hex');
}
function cursor(q: QueryInput, key: string) {
  if (!q.cursor) return null;
  try {
    const c = cursorSchema.parse(
      JSON.parse(Buffer.from(q.cursor, 'base64url').toString()),
    );
    if (c.filter !== key) throw new Error();
    return c;
  } catch {
    throw new DomainError('invalid_cursor', 400);
  }
}
async function refs(sql: Transaction, ledger: string, q: QueryFilter) {
  for (const [table, id] of [
    ['items', q.item_id],
    ['projects', q.project_id],
    ['payees', q.payee_id],
  ] as const) {
    if (
      id &&
      !(
        await sql`SELECT id FROM ${sql(table)} WHERE ledger_id=${ledger} AND id=${id}`
      ).length
    )
      throw new DomainError('not_found', 404);
  }
}
// All values are bound parameters. The one CTE defines the filter contract for
// details, summaries and both CSV forms; item matching selects transactions.
function filtered(
  sql: Transaction,
  actor: string,
  ledger: string,
  q: QueryFilter,
) {
  return sql`WITH RECURSIVE selected_items AS (
 SELECT id FROM items WHERE ledger_id=${ledger} AND id=${q.item_id ?? null}::uuid
 UNION ALL SELECT i.id FROM items i JOIN selected_items s ON i.parent_id=s.id WHERE i.ledger_id=${ledger}
), all_entries AS (
 SELECT e.*,i.name AS item_name,i.kind AS item_kind FROM transaction_entries e
 JOIN items i ON i.id=e.item_id AND i.ledger_id=e.ledger_id
 JOIN ledgers l ON l.id=e.ledger_id WHERE l.owner_id=${actor} AND e.ledger_id=${ledger}
), metrics AS (
 SELECT transaction_id,sum(CASE WHEN base_amount>0 THEN base_amount ELSE 0 END) AS transaction_amount,
 sum(CASE WHEN item_id IN (SELECT id FROM selected_items) THEN base_amount ELSE 0 END) AS selected_net_amount,
 bool_or(item_id IN (SELECT id FROM selected_items)) AS selected_hit FROM all_entries GROUP BY transaction_id
), filtered AS (
 SELECT t.*,m.transaction_amount,m.selected_net_amount,p.name AS payee_name,j.name AS project_name
 FROM transactions t JOIN ledgers l ON l.id=t.ledger_id JOIN metrics m ON m.transaction_id=t.id
 LEFT JOIN payees p ON p.id=t.payee_id AND p.ledger_id=t.ledger_id
 LEFT JOIN projects j ON j.id=t.project_id AND j.ledger_id=t.ledger_id
 WHERE l.owner_id=${actor} AND t.ledger_id=${ledger}
 AND (${q.date_from ?? null}::date IS NULL OR t.occurred_on>=${q.date_from ?? null}::date)
 AND (${q.date_to ?? null}::date IS NULL OR t.occurred_on<=${q.date_to ?? null}::date)
 AND (${q.item_id ?? null}::uuid IS NULL OR m.selected_hit)
 AND (${q.project_id ?? null}::uuid IS NULL OR t.project_id=${q.project_id ?? null}::uuid)
 AND (${q.payee_id ?? null}::uuid IS NULL OR t.payee_id=${q.payee_id ?? null}::uuid)
 AND (${q.kind ?? null}::text IS NULL OR t.kind=${q.kind ?? null})
 AND (${q.keyword ?? ''}='' OR position(lower(${q.keyword ?? ''}) IN lower(t.memo))>0 OR position(lower(${q.keyword ?? ''}) IN lower(t.invoice_no))>0)
 AND (${q.amount_min ?? null}::numeric IS NULL OR m.transaction_amount>=${q.amount_min ?? null}::numeric)
 AND (${q.amount_max ?? null}::numeric IS NULL OR m.transaction_amount<=${q.amount_max ?? null}::numeric)
)`;
}
function details(sql: Transaction, q: QueryFilter) {
  return sql`SELECT f.id,f.ledger_id,f.occurred_on::text,
 to_char(f.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 st.id AS security_trade_id,st.security_id,dp.deposit_id,
 f.kind,f.memo,f.invoice_no,f.payee_id,f.payee_name,f.project_id,f.project_name,f.transaction_amount::text,
 CASE WHEN ${q.item_id ?? null}::uuid IS NULL THEN NULL ELSE f.selected_net_amount::text END AS selected_net_amount,
 (SELECT jsonb_agg(jsonb_build_object('item_id',e.item_id,'item_name',e.item_name,'item_kind',e.item_kind,'amount',e.amount::text,'currency',e.currency,'exchange_rate',e.exchange_rate::text,'base_amount',e.base_amount::text,'entry_position',e.entry_position) ORDER BY e.entry_position) FROM all_entries e WHERE e.transaction_id=f.id) AS entries
 FROM filtered f LEFT JOIN security_trades st ON st.transaction_id=f.id AND st.ledger_id=f.ledger_id LEFT JOIN deposit_postings dp ON dp.transaction_id=f.id AND dp.ledger_id=f.ledger_id`;
}
async function totals(
  sql: Transaction,
  actor: string,
  ledger: string,
  q: QueryFilter,
): Promise<QueryTotals> {
  const [r] = await sql<
    { count: number; selected_net_amount: string | null }[]
  >`${filtered(sql, actor, ledger, q)} SELECT count(*)::int AS count,CASE WHEN ${q.item_id ?? null}::uuid IS NULL THEN NULL ELSE coalesce(sum(selected_net_amount),0)::text END AS selected_net_amount FROM filtered`;
  const by_kind = await sql<
    QueryTotals['by_kind']
  >`${filtered(sql, actor, ledger, q)} SELECT kind,count(*)::int AS count,sum(transaction_amount)::text AS transaction_amount FROM filtered GROUP BY kind ORDER BY kind`;
  return { ...r!, by_kind };
}
export function queryService(db: Database) {
  return {
    async search(
      actor: string,
      ledgerId: unknown,
      input: unknown = {},
    ): Promise<QueryPage> {
      const ledger = valid(idSchema, ledgerId);
      return (await db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const q = valid(querySchema, input);
        await refs(sql, ledger, q);
        const key = filterKey(actor, ledger, q),
          c = cursor(q, key);
        // Bind timestamp as text: postgres.js date serialization truncates microseconds.
        const rows = await sql<
          QueryRow[]
        >`${filtered(sql, actor, ledger, q)} ${details(sql, q)} WHERE (${c?.id ?? null}::uuid IS NULL OR (f.occurred_on,f.created_at,f.id)<(${c?.date ?? null}::date,${c?.created_at ?? null}::text::timestamptz,${c?.id ?? null}::uuid)) ORDER BY f.occurred_on DESC,f.created_at DESC,f.id DESC LIMIT ${q.limit + 1}`;
        for (const r of rows)
          if (!r.security_trade_id) {
            delete r.security_trade_id;
            delete r.security_id;
          }
        const items = rows.slice(0, q.limit),
          last = items.at(-1);
        return {
          items,
          next_cursor:
            rows.length > q.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    filter: key,
                    date: last.occurred_on,
                    created_at: last.created_at,
                    id: last.id,
                  }),
                ).toString('base64url')
              : null,
          totals: await totals(sql, actor, ledger, q),
        };
      })) as QueryPage;
    },
    async summary(
      actor: string,
      ledgerId: unknown,
      input: unknown,
    ): Promise<QuerySummary> {
      const ledger = valid(idSchema, ledgerId);
      return (await db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const q = valid(summarySchema, input);
        await refs(sql, ledger, q);
        const total = await totals(sql, actor, ledger, q);
        if (q.group_by === 'month') {
          const months = await sql<
            MonthSummary[]
          >`${filtered(sql, actor, ledger, q)} SELECT substring(occurred_on::text,1,7) AS month,kind,count(*)::int AS count,sum(transaction_amount)::text AS transaction_amount,CASE WHEN ${q.item_id ?? null}::uuid IS NULL THEN NULL ELSE sum(selected_net_amount)::text END AS selected_net_amount FROM filtered GROUP BY month,kind ORDER BY month DESC,kind`;
          const monthly_net = q.item_id
            ? await sql<
                { month: string; selected_net_amount: string }[]
              >`${filtered(sql, actor, ledger, q)} SELECT substring(occurred_on::text,1,7) AS month,sum(selected_net_amount)::text AS selected_net_amount FROM filtered GROUP BY month ORDER BY month DESC`
            : [];
          return {
            group_by: 'month',
            items: [],
            months,
            monthly_net,
            totals: total,
          };
        }
        const items = await sql<
          ItemSummary[]
        >`${filtered(sql, actor, ledger, q)}, scope_items AS (SELECT i.* FROM items i WHERE i.ledger_id=${ledger} AND (${q.item_id ?? null}::uuid IS NULL OR i.id IN (SELECT id FROM selected_items))), direct AS (
 SELECT i.id,i.parent_id,i.name,i.kind,count(e.id)::int AS entry_count,coalesce(sum(e.base_amount),0) AS signed_amount FROM scope_items i LEFT JOIN all_entries e ON e.item_id=i.id AND e.transaction_id IN (SELECT id FROM filtered) GROUP BY i.id,i.parent_id,i.name,i.kind
 ), closure AS (SELECT id AS ancestor,id AS descendant FROM scope_items UNION ALL SELECT c.ancestor,i.id FROM closure c JOIN scope_items i ON i.parent_id=c.descendant), rollups AS (
 SELECT c.ancestor,sum(d.signed_amount) AS signed_amount,sum(d.entry_count) AS n FROM closure c JOIN direct d ON d.id=c.descendant GROUP BY c.ancestor)
 SELECT d.id,d.parent_id,d.name,d.kind,d.entry_count,d.signed_amount::text, (CASE WHEN d.kind IN ('liability','income','equity') THEN -d.signed_amount ELSE d.signed_amount END)::text AS natural_amount,
 r.signed_amount::text AS rollup_signed_amount,(CASE WHEN d.kind IN ('liability','income','equity') THEN -r.signed_amount ELSE r.signed_amount END)::text AS rollup_natural_amount FROM direct d JOIN rollups r ON r.ancestor=d.id WHERE r.n>0 ORDER BY d.kind,lower(d.name),d.id`;
        return {
          group_by: 'item',
          items,
          months: [],
          monthly_net: [],
          totals: total,
        };
      })) as QuerySummary;
    },
    async all(
      actor: string,
      ledgerId: unknown,
      input: unknown = {},
    ): Promise<QueryRow[]> {
      const ledger = valid(idSchema, ledgerId);
      return (await db.begin(async (sql) => {
        return allQueryRows(sql, actor, ledger, input);
      })) as QueryRow[];
    },
  };
}

export async function allQueryRows(
  sql: Transaction,
  actor: string,
  ledger: string,
  input: unknown,
): Promise<QueryRow[]> {
  await ownedLedger(sql, actor, ledger);
  const q = valid(filterSchema, input);
  await refs(sql, ledger, q);
  return sql<
    QueryRow[]
  >`${filtered(sql, actor, ledger, q)} ${details(sql, q)} ORDER BY f.occurred_on DESC,f.created_at DESC,f.id DESC`;
}
