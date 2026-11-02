// SPDX-License-Identifier: AGPL-3.0-only
import { depositRows, depositPostings } from './deposits.js';
import { depositSchedule } from './deposit-math.js';
import { taipeiToday } from './ledger-lock.js';
import type { Database } from '@finmichi/db';
import { ownedLedger, valid, DomainError } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import { readCards, readLoans } from './finance.js';
import { cardAllocations, cardConvertedAmount } from './card-fx.js';
import { addDays } from './finance-calendar.js';
import { nextOccurrence } from './recurring-calendar.js';
import type {
  RecurringRule,
  RecurringOccurrence,
  RecurringTemplate,
} from './recurring-schemas.js';
import { scaled } from './finance-schemas.js';
import {
  cashForecastSchema,
  type CashForecastReport,
  type ForecastEvent,
} from './cash-forecast-schemas.js';
const moneyUnits = (value: string) => {
  // Failed occurrences can retain invalid input. Do not reinterpret excess scale as a larger amount.
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(value))
    throw new DomainError('invalid_money_entry', 400);
  return scaled(value, 6);
};
// Booked base amounts have two places; retain any extra template precision rather than truncate it.
// This formats units only; it never converts currencies or uses floating point.
const text = (n: bigint) => {
  const absolute = n < 0n ? -n : n;
  const fraction = String(absolute % 1000000n)
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `${n < 0n ? '-' : ''}${absolute / 1000000n}.${fraction}`;
};
export { taipeiToday as forecastToday } from './ledger-lock.js';
export function cashForecastService(db: Database) {
  return {
    async forecast(
      actor: string,
      ledgerId: string,
      input: unknown,
    ): Promise<CashForecastReport> {
      valid(idSchema, actor);
      const ledger = valid(idSchema, ledgerId);
      const q = valid(cashForecastSchema, input),
        today = taipeiToday(),
        end = addDays(today, q.horizon_days - 1),
        requested = q.accounts?.map((id) => id.toLowerCase());
      if (requested && new Set(requested).size !== requested.length)
        throw new DomainError('invalid_input', 400);
      // Enforced by PostgreSQL too: no service called here can accidentally write or generate occurrences.
      return (await db.begin(
        'isolation level repeatable read read only',
        async (sql) => {
          const owned = await ownedLedger(sql, actor, ledger, false);
          const all = await sql<
            {
              id: string;
              name: string;
              kind: string;
              currency: string;
              archived: boolean;
              loan: boolean;
            }[]
          >`SELECT id,name,kind,currency,archived,loan FROM items WHERE ledger_id=${ledger} ORDER BY name,id`;
          if (requested)
            for (const id of requested) {
              const item = all.find((i) => i.id === id);
              if (!item) throw new DomainError('not_found', 404);
              if (item.kind !== 'asset')
                throw new DomainError('invalid_input', 400);
            }
          const selected = all.filter(
            (i) =>
              i.currency === owned.base_currency &&
              i.kind === 'asset' &&
              (requested ? requested.includes(i.id) : !i.archived && !i.loan),
          );
          const ids = new Set(selected.map((i) => i.id));
          const sums = await sql<
            { item_id: string; balance: string }[]
          >`SELECT e.item_id,sum(e.base_amount)::text AS balance FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id AND t.ledger_id=e.ledger_id WHERE e.ledger_id=${ledger} AND t.occurred_on<=${today} GROUP BY e.item_id`;
          const accounts = selected.map((i) => ({
            id: i.id,
            name: i.name,
            opening_balance: text(
              moneyUnits(sums.find((b) => b.item_id === i.id)?.balance ?? '0'),
            ),
          }));
          const events: ForecastEvent[] = [];
          function event(
            date: string,
            type: ForecastEvent['source_type'],
            source: string,
            memo: string,
            account: string,
            amount: string,
          ) {
            const actual = date < today ? today : date;
            if (!ids.has(account) || actual > end || moneyUnits(amount) === 0n)
              return;
            events.push({
              date: actual,
              source_type: type,
              source_id: source,
              memo,
              account_id: account,
              amount: text(moneyUnits(amount)),
            });
          }
          function template(
            date: string,
            type: 'occurrence' | 'recurring',
            id: string,
            t: RecurringTemplate,
          ) {
            // A template may contain multiple legs for one account; coalesce them before emitting the account event.
            const amounts = new Map<string, bigint>();
            for (const e of t.entries)
              if (ids.has(e.item_id))
                amounts.set(
                  e.item_id,
                  (amounts.get(e.item_id) ?? 0n) + moneyUnits(e.amount),
                );
            for (const [account, n] of amounts)
              event(date, type, id, t.memo, account, text(n));
          }
          const future = await sql<
            {
              id: string;
              date: string;
              memo: string;
              item_id: string;
              amount: string;
            }[]
          >`SELECT t.id,t.occurred_on::text AS date,t.memo,e.item_id,sum(e.base_amount)::text AS amount FROM transactions t JOIN transaction_entries e ON e.transaction_id=t.id AND e.ledger_id=t.ledger_id WHERE t.ledger_id=${ledger} AND t.occurred_on>${today} AND t.occurred_on<=${end} GROUP BY t.id,t.occurred_on,t.memo,e.item_id ORDER BY t.occurred_on,t.created_at,t.id,e.item_id`;
          for (const t of future)
            event(t.date, 'transaction', t.id, t.memo, t.item_id, t.amount);
          const occurrences = await sql<
            RecurringOccurrence[]
          >`SELECT *,occurs_on::text,occurred_on::text FROM recurring_occurrences WHERE ledger_id=${ledger}`;
          const keys = new Set(
            occurrences.map((o) => `${o.source_rule_id}:${o.occurs_on}`),
          );
          for (const o of occurrences)
            if (o.status === 'pending' || o.status === 'failed')
              template(o.occurred_on, 'occurrence', o.id, o.template);
          const rules = await sql<
            RecurringRule[]
          >`SELECT *,start_on::text,end_on::text,next_on::text FROM recurring_rules WHERE ledger_id=${ledger} AND active AND next_on IS NOT NULL`;
          for (const r of rules)
            for (
              let date = r.next_on;
              date && date <= end && (!r.end_on || date <= r.end_on);
              date = nextOccurrence(r, date)
            ) {
              if (!keys.has(`${r.id}:${date}`))
                template(date, 'recurring', `${r.id}:${date}`, r.template);
            }
          const cards = await readCards(sql, actor, ledger, today);
          const warnings: CashForecastReport['warnings'] = [];
          for (const c of cards.cards) {
            if (!c.payment_account_id || !ids.has(c.payment_account_id))
              continue;
            const allocations = cardAllocations(c).filter(
              (b) => b.due_on <= end,
            );
            if (c.currency !== owned.base_currency && !c.payment_quote) {
              if (allocations.length)
                warnings.push({
                  source_type: 'card',
                  item_id: c.item_id,
                  code: 'fx_rate_missing',
                });
              continue;
            }
            for (const b of allocations) {
              const quote =
                c.currency !== owned.base_currency ? c.payment_quote : null;
              event(
                b.due_on,
                'card',
                `${c.item_id}:${b.statement_on}`,
                c.name +
                  (b.unclosed ? ' 未結帳消費' : ' 帳單') +
                  (quote
                    ? `・估算（匯率 ${quote.rate}，日期 ${quote.rate_date}）`
                    : ''),
                c.payment_account_id,
                quote ? cardConvertedAmount(b.amount, quote.rate) : b.amount,
              );
            }
          }
          const deposits = await depositRows(sql, ledger),
            depositPs = await depositPostings(sql, ledger);
          for (const d of deposits) {
            if (d.status !== 'active') continue;
            const schedule = depositSchedule(d),
              posted = new Set(
                depositPs
                  .filter((p) => p.deposit_id === d.id && p.kind === 'interest')
                  .map((p) => p.period_no),
              );
            for (const p of schedule.periods) {
              const final = p.due_on === d.maturity_on;
              const interest = posted.has(p.period_no)
                ? 0n
                : moneyUnits(p.interest);
              const principal =
                final && !d.auto_renew ? moneyUnits(d.principal) : 0n;
              event(
                p.due_on,
                'deposit',
                `${d.id}:${p.period_no}:payout`,
                d.bank,
                d.payout_account_id,
                text(principal + interest),
              );
              if (principal)
                event(
                  p.due_on,
                  'deposit',
                  `${d.id}:${p.period_no}:principal`,
                  d.bank,
                  d.item_id,
                  text(-principal),
                );
            }
          }
          const loans = await readLoans(sql, actor, ledger, today);
          for (const l of loans.loans)
            if (ids.has(l.payment_account_id))
              for (const p of l.schedule) {
                if (p.due_on >= today && moneyUnits(p.payment) > 0n)
                  event(
                    p.due_on,
                    'loan',
                    `${l.item_id}:${p.period}`,
                    `${l.name} 第 ${p.period} 期`,
                    l.payment_account_id,
                    text(-moneyUnits(p.payment)),
                  );
              }
          // Card deltas above are outflows, irrespective of the liability's natural direction.
          for (const e of events)
            if (e.source_type === 'card')
              e.amount = text(-moneyUnits(e.amount));
          events.sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              a.source_type.localeCompare(b.source_type) ||
              a.source_id.localeCompare(b.source_id) ||
              a.account_id.localeCompare(b.account_id),
          );
          const balances = new Map(
            accounts.map((a) => [a.id, moneyUnits(a.opening_balance)]),
          );
          const opening = [...balances.values()].reduce((a, b) => a + b, 0n),
            days: CashForecastReport['days'] = [];
          let first: string | null = null,
            index = 0;
          for (let d = 0; d < q.horizon_days; d++) {
            const date = addDays(today, d);
            while (events[index]?.date === date) {
              const e = events[index++]!;
              balances.set(
                e.account_id,
                balances.get(e.account_id)! + moneyUnits(e.amount),
              );
            }
            const total = [...balances.values()].reduce((a, b) => a + b, 0n);
            if (first === null && total < moneyUnits(q.threshold)) first = date;
            days.push({
              date,
              total: text(total),
              balances: [...balances].map(([account_id, n]) => ({
                account_id,
                balance: text(n),
              })),
            });
          }
          return {
            warnings,
            generated_at: new Date().toISOString(),
            as_of: today,
            date_to: end,
            base_currency: owned.base_currency,
            horizon_days: q.horizon_days,
            threshold: text(moneyUnits(q.threshold)),
            accounts,
            opening_total: text(opening),
            days,
            events,
            first_below_threshold: first,
          };
        },
      )) as CashForecastReport;
    },
  };
}
