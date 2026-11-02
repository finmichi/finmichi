// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Database, Transaction } from '@finmichi/db';
import { ownedLedger, valid, mutation } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import { canonicalJson } from './backups.js';
import { taipeiToday } from './ledger-lock.js';
import { addDays } from './finance-calendar.js';
import { depositDays } from './deposit-math.js';
import { readCards, readLoans } from './finance.js';
import { cardAllocations } from './card-fx.js';
import { readMarketRuns } from './market-store.js';
import { marketAge } from './market-math.js';
import type { MarketDay } from './market-schemas.js';
import {
  reminderTypes,
  reminderSettingsSchema,
  reminderReadSchema,
  type Reminder,
  type RemindersResult,
} from './reminder-schemas.js';
export const reminderFingerprint = (fields: unknown) =>
  createHash('sha256').update(canonicalJson(fields)).digest('hex');
async function settings(sql: Transaction, ledger: string) {
  const [r] =
    await sql`SELECT * FROM reminder_settings WHERE ledger_id=${ledger}`;
  if (!r) return reminderSettingsSchema.parse({});
  const { ledger_id: _ledger, ...values } = r;
  void _ledger;
  return reminderSettingsSchema.parse(values);
}
export async function readReminders(
  sql: Transaction,
  actor: string,
  ledger: string,
): Promise<RemindersResult> {
  const l = await ownedLedger(sql, actor, ledger, false),
    s = await settings(sql, ledger),
    today = taipeiToday();
  const items: Reminder[] = [];
  const reads = await sql<
    { key: string; fingerprint: string }[]
  >`SELECT key,fingerprint FROM reminder_reads WHERE ledger_id=${ledger}`;
  const readMap = new Map(reads.map((r) => [r.key, r.fingerprint]));
  function add(
    type: Reminder['type'],
    key: string,
    date: string,
    fields: unknown,
    title: string,
    detail: string,
    href: string,
  ) {
    const fingerprint = reminderFingerprint(fields);
    items.push({
      key,
      fingerprint,
      type,
      date,
      overdue_days: Math.max(0, depositDays(date, today)),
      title,
      detail,
      href,
      read: readMap.get(key) === fingerprint,
    });
  }
  if (s.deposit_enabled) {
    const rows = await sql<
      {
        id: string;
        maturity_on: string;
        principal: string;
        status: string;
        name: string;
        currency: string;
      }[]
    >`SELECT d.id,d.maturity_on::text,d.principal::text,d.status,i.name,i.currency FROM fixed_deposits d JOIN items i ON i.id=d.item_id AND i.ledger_id=d.ledger_id WHERE d.ledger_id=${ledger} AND d.status='active' AND d.maturity_on<=${addDays(today, s.deposit_days)}`;
    for (const r of rows)
      add(
        'deposit',
        `deposit:${r.id}`,
        r.maturity_on,
        {
          maturity_on: r.maturity_on,
          principal: r.principal,
          status: r.status,
        },
        r.name,
        r.maturity_on < today
          ? `已到期 ${depositDays(r.maturity_on, today)} 天，待處理`
          : `定存將於 ${r.maturity_on} 到期`,
        '/investments?tab=deposits',
      );
  }
  if (s.card_enabled)
    for (const c of (await readCards(sql, actor, ledger, today)).cards) {
      for (const b of cardAllocations(c).filter(
        (b) => !b.unclosed && b.due_on <= addDays(today, s.card_days),
      ))
        add(
          'card',
          `card:${c.item_id}:${b.statement_on}`,
          b.due_on,
          { due_on: b.due_on, amount: b.amount, currency: c.currency },
          c.name,
          `${b.statement_on} 帳單待繳 ${c.currency} ${b.amount.replace(/0+$/, '').replace(/\.$/, '')}（${b.due_on}）`,
          '/admin/cards',
        );
    }
  if (s.loan_enabled)
    for (const l of (await readLoans(sql, actor, ledger, today)).loans)
      for (const p of l.schedule) {
        if (
          p.due_on >= today &&
          p.due_on <= addDays(today, s.loan_days) &&
          /[1-9]/.test(p.payment)
        )
          add(
            'loan',
            `loan:${l.item_id}:${p.period}`,
            p.due_on,
            { due_on: p.due_on, payment: p.payment },
            l.name,
            `第 ${p.period} 期 ${l.currency} ${p.payment}`,
            '/admin/loans',
          );
      }
  if (s.recurring_enabled) {
    const rows = await sql<
      { id: string; occurred_on: string; status: string; template: unknown }[]
    >`SELECT id,occurred_on::text,status,template FROM recurring_occurrences WHERE ledger_id=${ledger} AND status IN('pending','failed') AND occurred_on<=${addDays(today, s.recurring_days)}`;
    for (const r of rows)
      add(
        'recurring',
        `occurrence:${r.id}`,
        r.occurred_on,
        { occurred_on: r.occurred_on, status: r.status, template: r.template },
        '週期交易待確認',
        r.status === 'failed' ? '上次入帳失敗，請檢查後重試' : '請確認當期交易',
        '/admin/recurring?view=pending',
      );
  }
  if (s.draft_enabled) {
    const rows = await sql<
      { id: string; date: string; payload: unknown }[]
    >`SELECT id,(created_at AT TIME ZONE 'Asia/Taipei')::date::text AS date,payload FROM transaction_drafts WHERE ledger_id=${ledger} AND status='pending' AND created_at>now()-interval '14 days' AND (created_at AT TIME ZONE 'Asia/Taipei')::date<=${addDays(today, s.draft_days)}`;
    for (const r of rows)
      add(
        'draft',
        `draft:${r.id}`,
        r.date,
        { payload: r.payload },
        'AI 草稿待審核',
        '確認內容後才能入帳',
        '/admin/drafts',
      );
  }
  if (s.market_enabled) {
    const [flags] =
      await sql`SELECT coalesce(bool_or(securities),false) AS stocks,coalesce(bool_or(currency<>${l.base_currency}),false) AS fx FROM items WHERE ledger_id=${ledger}`;
    const runs = await readMarketRuns(sql),
      calendar = await sql<
        MarketDay[]
      >`SELECT date::text,market,is_trading_day,source FROM market_calendar`;
    for (const r of runs) {
      if (
        !(r.source === 'bot'
          ? flags!.fx
          : (r.source === 'twse' || r.source === 'tpex') && flags!.stocks)
      )
        continue;
      const age = r.data_date
        ? marketAge(r.data_date, today, calendar, r.source === 'bot')
        : null;
      if (
        r.status === 'blocked_by_source' ||
        (age && age.days >= s.market_trading_days)
      )
        add(
          'market',
          `market:${r.source}`,
          r.data_date ?? today,
          { data_date: r.data_date, status: r.status },
          `${r.source === 'bot' ? '臺銀匯率' : r.source === 'twse' ? '證交所股價' : '櫃買股價'}待更新`,
          r.status === 'blocked_by_source'
            ? '來源暫時阻擋存取'
            : `行情落後 ${age!.days} 個交易日${age!.estimated ? '（依平日估算）' : ''}`,
          '/admin/exchange-rates',
        );
    }
  }
  items.sort(
    (a, b) =>
      Number(b.overdue_days > 0) - Number(a.overdue_days > 0) ||
      a.date.localeCompare(b.date) ||
      reminderTypes.indexOf(a.type) - reminderTypes.indexOf(b.type) ||
      a.key.localeCompare(b.key),
  );
  return {
    as_of: today,
    items,
    unread_count: items.filter((r) => !r.read).length,
  };
}
export function reminderService(db: Database) {
  const read = async <T>(
    actor: string,
    ledger: unknown,
    f: (sql: Transaction, id: string) => Promise<T>,
  ) => {
    valid(idSchema, actor);
    const id = valid(idSchema, ledger);
    return (await db.begin(
      'isolation level repeatable read read only',
      async (sql) => {
        await ownedLedger(sql, actor, id, false);
        return f(sql, id);
      },
    )) as T;
  };
  return {
    list: (actor: string, ledger: unknown) =>
      read(actor, ledger, (sql, id) => readReminders(sql, actor, id)),
    settings: (actor: string, ledger: unknown) => read(actor, ledger, settings),
    saveSettings: (actor: string, ledger: unknown, input: unknown) =>
      mutation(db, actor, 'reminder.settings_update', async (sql) => {
        const id = valid(idSchema, ledger),
          q = valid(reminderSettingsSchema, input);
        await ownedLedger(sql, actor, id);
        await sql`INSERT INTO reminder_settings ${sql({ ...q, ledger_id: id })} ON CONFLICT(ledger_id) DO UPDATE SET ${sql(q)}`;
        return q;
      }),
    async markRead(actor: string, ledger: unknown, input: unknown) {
      valid(idSchema, actor);
      const id = valid(idSchema, ledger),
        q = valid(reminderReadSchema, input);
      return await db.begin(async (sql) => {
        await ownedLedger(sql, actor, id); // Serialize read marking and bounded cleanup for this ledger.
        const current = (await readReminders(sql, actor, id)).items;
        const requested = 'all' in q ? current : q.items;
        const fingerprints = new Map(
          current.map((r) => [r.key, r.fingerprint]),
        );
        const keys = new Set(
          requested
            .filter((r) => fingerprints.get(r.key) === r.fingerprint)
            .map((r) => r.key),
        );
        const rows = current
          .filter((r) => keys.has(r.key))
          .map((r) => ({
            ledger_id: id,
            key: r.key,
            fingerprint: r.fingerprint,
          }));
        for (let start = 0; start < rows.length; start += 500)
          await sql`INSERT INTO reminder_reads ${sql(rows.slice(start, start + 500))} ON CONFLICT(ledger_id,key) DO UPDATE SET fingerprint=excluded.fingerprint,read_at=now()`;
        await sql`DELETE FROM reminder_reads WHERE ledger_id=${id} AND key IN(SELECT key FROM reminder_reads WHERE ledger_id=${id} ORDER BY read_at DESC,key OFFSET 1000)`;
        return { marked: rows.length };
      });
    },
  };
}
