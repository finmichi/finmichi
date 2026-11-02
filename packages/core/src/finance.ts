// SPDX-License-Identifier: AGPL-3.0-only
import { assertPostableItem } from './postable.js';
import { readMarketFx } from './market-store.js';
import { cardQuote } from './card-fx.js';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import {
  cardSettingsSchema,
  loanSettingsSchema,
  validCardSchedule,
  type CardSettings,
  type LoanSettings,
} from './finance-schemas.js';
import {
  amortize,
  cardPeriod,
  monthDate,
  addDays,
} from './finance-calendar.js';
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
async function reference(
  sql: Transaction,
  ledger: string,
  id: string,
  kind: string,
  baseCurrency: string | string[] | null,
  flag?: 'credit_card' | 'loan',
  old?: string | null,
) {
  const [r] =
    await sql`SELECT kind,credit_card,loan,archived,currency FROM items WHERE id=${id} AND ledger_id=${ledger} FOR UPDATE`;
  if (!r) throw new DomainError('not_found', 404);
  if (
    baseCurrency !== null &&
    !(Array.isArray(baseCurrency) ? baseCurrency : [baseCurrency]).includes(
      r.currency,
    )
  )
    throw new DomainError('currency_not_supported', 400);
  if (r.kind !== kind || (flag && !r[flag]))
    throw new DomainError('finance_item_kind_invalid', 400);
  await assertPostableItem(sql, ledger, id, old === id);
  return r;
}
export function financeService(db: Database) {
  async function save(
    actor: string,
    ledgerId: unknown,
    input: unknown,
    type: 'card' | 'loan',
  ) {
    return mutation(
      db,
      actor,
      type === 'card' ? 'card.update' : 'loan.update',
      async (sql) => {
        const ledger = valid(idSchema, ledgerId);
        const owned = await ownedLedger(sql, actor, ledger);
        if (type === 'card') {
          const q = valid(cardSettingsSchema, input);
          const [old] =
            await sql`SELECT * FROM credit_card_settings WHERE ledger_id=${ledger} AND item_id=${q.item_id}`;
          if (!validCardSchedule(q))
            throw new DomainError('invalid_card_schedule', 400);
          const card = await reference(
            sql,
            ledger,
            q.item_id,
            'liability',
            null,
            'credit_card',
            old ? q.item_id : undefined,
          );
          if (q.payment_account_id)
            await reference(
              sql,
              ledger,
              q.payment_account_id,
              'asset',
              [owned.base_currency, String(card.currency)],
              undefined,
              old?.payment_account_id,
            );
          await sql`INSERT INTO credit_card_settings ${sql({ ...q, ledger_id: ledger })} ON CONFLICT(item_id) DO UPDATE SET statement_day=excluded.statement_day,due_day=excluded.due_day,due_month_offset=excluded.due_month_offset,payment_account_id=excluded.payment_account_id,credit_limit=excluded.credit_limit`;
        } else {
          const q = valid(loanSettingsSchema, input);
          const [old] =
            await sql`SELECT * FROM loan_settings WHERE ledger_id=${ledger} AND item_id=${q.item_id}`;
          await reference(
            sql,
            ledger,
            q.item_id,
            'liability',
            owned.base_currency,
            'loan',
            old ? q.item_id : undefined,
          );
          await reference(
            sql,
            ledger,
            q.payment_account_id,
            'asset',
            owned.base_currency,
            undefined,
            old?.payment_account_id,
          );
          await reference(
            sql,
            ledger,
            q.interest_item_id,
            'expense',
            owned.base_currency,
            undefined,
            old?.interest_item_id,
          );
          await sql`INSERT INTO loan_settings ${sql({ ...q, ledger_id: ledger })} ON CONFLICT(item_id) DO UPDATE SET principal=excluded.principal,annual_rate=excluded.annual_rate,term_months=excluded.term_months,first_payment_on=excluded.first_payment_on,method=excluded.method,payment_account_id=excluded.payment_account_id,interest_item_id=excluded.interest_item_id`;
        }
        return { saved: true };
      },
    );
  }
  return {
    saveCard: (a: string, l: unknown, i: unknown) => save(a, l, i, 'card'),
    saveLoan: (a: string, l: unknown, i: unknown) => save(a, l, i, 'loan'),
    async remove(
      actor: string,
      ledgerId: unknown,
      itemId: unknown,
      type: 'card' | 'loan',
    ) {
      return mutation(
        db,
        actor,
        type === 'card' ? 'card.delete' : 'loan.delete',
        async (sql) => {
          const ledger = valid(idSchema, ledgerId),
            id = valid(idSchema, itemId);
          await ownedLedger(sql, actor, ledger);
          const rows =
            type === 'card'
              ? await sql`DELETE FROM credit_card_settings WHERE ledger_id=${ledger} AND item_id=${id} RETURNING item_id`
              : await sql`DELETE FROM loan_settings WHERE ledger_id=${ledger} AND item_id=${id} RETURNING item_id`;
          if (!rows.length) throw new DomainError('not_found', 404);
        },
      );
    },
    async cards(actor: string, ledgerId: unknown, asOf = today()) {
      const ledger = valid(idSchema, ledgerId);
      return db.begin((sql) => readCards(sql, actor, ledger, asOf));
    },
    async loans(actor: string, ledgerId: unknown, asOf = today()) {
      const ledger = valid(idSchema, ledgerId);
      return db.begin((sql) => readLoans(sql, actor, ledger, asOf));
    },
  };
}
export type CardsResult = Awaited<
  ReturnType<ReturnType<typeof financeService>['cards']>
>;
export type LoansResult = Awaited<
  ReturnType<ReturnType<typeof financeService>['loans']>
>;

export async function readCards(
  sql: Transaction,
  actor: string,
  ledger: string,
  asOf: string,
) {
  const owned = await ownedLedger(sql, actor, ledger, false);
  const fx = await readMarketFx(sql, asOf);
  const ledgerRates = await sql<
    {
      rate_date: string;
      from_currency: string;
      to_currency: string;
      rate: string;
    }[]
  >`SELECT rate_date::text,from_currency,to_currency,rate::text FROM exchange_rates WHERE ledger_id=${ledger} AND rate_date<=${asOf} ORDER BY rate_date DESC`;
  const settings = await sql<
    (CardSettings & {
      name: string;
      currency: string;
      ledger_id: string;
      payment_currency: string | null;
    })[]
  >`SELECT s.*,p.currency AS payment_currency,s.credit_limit::text,i.name,i.currency FROM credit_card_settings s JOIN items i ON i.id=s.item_id AND i.ledger_id=s.ledger_id LEFT JOIN items p ON p.id=s.payment_account_id AND p.ledger_id=s.ledger_id WHERE s.ledger_id=${ledger} ORDER BY i.name,s.item_id`;
  const cards = [];
  for (const s of settings) {
    const currentClose = monthDate(asOf, 0, s.statement_day),
      lastClose =
        currentClose <= asOf
          ? currentClose
          : monthDate(asOf, -1, s.statement_day);
    const bills = [];
    for (let j = 0; j < 12; j++) {
      const period = cardPeriod(s, monthDate(lastClose, -j, 1));
      const [r] =
        await sql`SELECT (-coalesce(sum(e.amount) FILTER(WHERE t.occurred_on<=${period.to}),0))::text AS amount_due,coalesce(sum(e.amount) FILTER(WHERE t.occurred_on>${period.to} AND t.occurred_on<=${period.due_on} AND t.occurred_on<=${asOf} AND e.amount>0),0)::text AS paid FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id AND t.ledger_id=e.ledger_id WHERE e.ledger_id=${ledger} AND e.item_id=${s.item_id}`;
      const [u] =
        await sql`SELECT (${r!.amount_due}::numeric-${r!.paid}::numeric)::text AS unpaid`;
      bills.push({
        ...period,
        amount_due: r!.amount_due as string,
        paid: r!.paid as string,
        unpaid: u!.unpaid as string,
      });
    }
    const [current] =
      await sql`SELECT (-coalesce(sum(e.amount),0))::text AS balance FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id AND t.ledger_id=e.ledger_id WHERE e.ledger_id=${ledger} AND e.item_id=${s.item_id} AND t.occurred_on<=${asOf}`;
    const [ratio] =
      await sql`SELECT CASE WHEN ${s.credit_limit}::numeric>0 THEN round(${current!.balance}::numeric/${s.credit_limit}::numeric*100,10)::text ELSE NULL END AS utilization`;
    const nextClose =
      currentClose > asOf ? currentClose : monthDate(asOf, 1, s.statement_day);
    cards.push({
      ...s,
      payment_quote:
        s.currency === owned.base_currency
          ? null
          : cardQuote(fx, ledgerRates, s.currency, owned.base_currency, asOf),
      current_balance: current!.balance as string,
      utilization: ratio!.utilization as string | null,
      next_close: nextClose,
      next_due:
        bills
          .filter((b) => b.due_on >= asOf)
          .sort((a, b) => a.due_on.localeCompare(b.due_on))[0]?.due_on ??
        cardPeriod(s, nextClose).due_on,
      bills,
    });
  }
  return {
    as_of: asOf,
    cards,
    due_soon: cards.flatMap((c) =>
      c.bills
        .filter(
          (b) =>
            b.due_on >= asOf &&
            b.due_on <= addDays(asOf, 7) &&
            !b.unpaid.startsWith('-') &&
            /[1-9]/.test(b.unpaid),
        )
        .map((b) => ({
          item_id: c.item_id,
          name: c.name,
          currency: c.currency,
          due_on: b.due_on,
          unpaid: b.unpaid,
        })),
    ),
  };
}

export async function readLoans(
  sql: Transaction,
  actor: string,
  ledger: string,
  asOf: string,
) {
  await ownedLedger(sql, actor, ledger, false);
  const settings = await sql<
    (LoanSettings & {
      name: string;
      currency: string;
      ledger_id: string;
    })[]
  >`SELECT s.*,s.principal::text,s.annual_rate::text,s.first_payment_on::text,i.name,i.currency FROM loan_settings s JOIN items i ON i.id=s.item_id AND i.ledger_id=s.ledger_id WHERE s.ledger_id=${ledger} ORDER BY i.name,s.item_id`;
  const loans = [];
  for (const s of settings) {
    const schedule = amortize(
      loanSettingsSchema.parse({
        item_id: s.item_id,
        principal: s.principal,
        annual_rate: s.annual_rate,
        term_months: s.term_months,
        first_payment_on: s.first_payment_on,
        method: s.method,
        payment_account_id: s.payment_account_id,
        interest_item_id: s.interest_item_id,
      }),
    );
    const [r] =
      await sql`SELECT (-coalesce(sum(e.amount),0))::text AS actual_balance,round(-coalesce(sum(e.amount),0),2)::text AS new_principal FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id AND t.ledger_id=e.ledger_id WHERE e.ledger_id=${ledger} AND e.item_id=${s.item_id} AND t.occurred_on<=${asOf}`;
    const elapsed = schedule.filter((p) => p.due_on <= asOf).length,
      expected = elapsed ? schedule[elapsed - 1]!.closing : s.principal;
    const [d] =
      await sql`SELECT (${r!.actual_balance}::numeric-${expected}::numeric)::text AS difference`;
    loans.push({
      ...s,
      schedule,
      actual_balance: r!.actual_balance as string,
      expected_balance: expected,
      difference: d!.difference as string,
      recalculation: {
        principal: r!.new_principal as string,
        term_months: Math.max(1, s.term_months - elapsed),
        first_payment_on: asOf,
      },
    });
  }
  return { as_of: asOf, loans };
}
