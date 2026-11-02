// SPDX-License-Identifier: AGPL-3.0-only
import { assertPostableItem } from './postable.js';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import { createTransaction } from './transactions.js';
import { nextOccurrence } from './recurring-calendar.js';
import { taipeiToday } from './ledger-lock.js';
import {
  recurringRuleSchema,
  occurrencePatchSchema,
  occurrenceQuerySchema,
  occurrenceIdsSchema,
  type RecurringRule,
  type RecurringOccurrence,
  type RecurringTemplate,
} from './recurring-schemas.js';
const ruleColumns =
  'id,ledger_id,name,template,frequency,interval,day_of_month,weekday,month,day,start_on::text,end_on::text,active,auto_post,next_on::text';
const occColumns =
  'id,ledger_id,rule_id,source_rule_id,rule_name,occurs_on::text,occurred_on::text,template,status,transaction_id,error_code';
async function rule(sql: Transaction, ledger: string, id: string) {
  const [r] = await sql.unsafe<RecurringRule[]>(
    'SELECT ' +
      ruleColumns +
      ' FROM recurring_rules WHERE ledger_id=$1 AND id=$2 FOR UPDATE',
    [ledger, id],
  );
  if (!r) throw new DomainError('not_found', 404);
  return r;
}
async function occurrence(sql: Transaction, ledger: string, id: string) {
  const [r] = await sql.unsafe<RecurringOccurrence[]>(
    'SELECT ' +
      occColumns +
      ' FROM recurring_occurrences WHERE ledger_id=$1 AND id=$2 FOR UPDATE',
    [ledger, id],
  );
  if (!r) throw new DomainError('not_found', 404);
  return r;
}
async function references(
  sql: Transaction,
  ledger: string,
  t: RecurringTemplate,
  old?: RecurringTemplate,
) {
  const previous = old?.entries.map((e) => e.item_id) ?? [];
  for (const e of t.entries) {
    const [i] =
      await sql`SELECT id FROM items WHERE id=${e.item_id} AND ledger_id=${ledger}`;
    if (!i) throw new DomainError('item_ledger_mismatch', 400);
    const index = previous.indexOf(e.item_id);
    await assertPostableItem(sql, ledger, e.item_id, index >= 0);
    if (index >= 0) previous.splice(index, 1);
  }
  for (const [key, table] of [
    ['payee_id', 'payees'],
    ['project_id', 'projects'],
  ] as const)
    if (t[key]) {
      const [r] =
        await sql`SELECT id FROM ${sql(table)} WHERE id=${t[key]} AND ledger_id=${ledger}`;
      if (!r)
        throw new DomainError(
          key === 'payee_id'
            ? 'payee_ledger_mismatch'
            : 'project_ledger_mismatch',
          400,
        );
    }
}
export function recurringService(db: Database) {
  const service = {
    async state(actor: string, ledgerId: unknown) {
      const ledger = valid(idSchema, ledgerId);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const rules = await sql.unsafe<RecurringRule[]>(
          'SELECT ' +
            ruleColumns +
            ' FROM recurring_rules WHERE ledger_id=$1 ORDER BY name,id',
          [ledger],
        );
        const [c] =
          await sql`SELECT count(*)::int n FROM recurring_occurrences WHERE ledger_id=${ledger} AND status IN ('pending','failed')`;
        const [worker] =
          await sql`SELECT last_started_at::text,last_finished_at::text,status,error_code,next_retry_at::text FROM recurring_worker_runs WHERE ledger_id=${ledger}`;
        return { rules, pending_count: Number(c!.n), worker: worker ?? null };
      });
    },
    async save(actor: string, ledgerId: unknown, input: unknown, id?: unknown) {
      return mutation(
        db,
        actor,
        id === undefined ? 'recurring.create' : 'recurring.update',
        async (sql) => {
          const ledger = valid(idSchema, ledgerId);
          await ownedLedger(sql, actor, ledger);
          const data = valid(recurringRuleSchema, input);
          const old =
            id === undefined
              ? null
              : await rule(sql, ledger, valid(idSchema, id));
          await references(sql, ledger, data.template, old?.template);
          const schedule = [
            'frequency',
            'interval',
            'day_of_month',
            'weekday',
            'month',
            'day',
            'start_on',
          ] as const;
          const changed = !old || schedule.some((k) => old[k] !== data[k]);
          const fields = {
            ...data,
            template: sql.json(data.template),
            next_on: changed ? nextOccurrence(data) : old!.next_on,
          };
          let saved: string;
          if (old) {
            await sql`UPDATE recurring_rules SET ${sql(fields)} WHERE id=${old.id} AND ledger_id=${ledger}`;
            saved = old.id;
          } else {
            const [r] =
              await sql`INSERT INTO recurring_rules ${sql({ ...fields, ledger_id: ledger })} RETURNING id`;
            saved = String(r!.id);
          }
          return rule(sql, ledger, saved);
        },
      );
    },
    async remove(actor: string, ledgerId: unknown, id: unknown) {
      return mutation(db, actor, 'recurring.delete', async (sql) => {
        const ledger = valid(idSchema, ledgerId);
        await ownedLedger(sql, actor, ledger);
        const r = await rule(sql, ledger, valid(idSchema, id));
        await sql`DELETE FROM recurring_occurrences WHERE ledger_id=${ledger} AND rule_id=${r.id} AND status IN ('pending','failed')`;
        await sql`DELETE FROM recurring_rules WHERE id=${r.id} AND ledger_id=${ledger}`;
      });
    },
    async occurrences(actor: string, ledgerId: unknown, query: unknown = {}) {
      const ledger = valid(idSchema, ledgerId),
        q = valid(occurrenceQuerySchema, query);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        return sql.unsafe<RecurringOccurrence[]>(
          'SELECT ' +
            occColumns +
            ' FROM recurring_occurrences WHERE ledger_id=$1' +
            (q.status
              ? ' AND status=$2'
              : " AND status IN ('pending','failed')") +
            ' ORDER BY occurred_on,id',
          q.status ? [ledger, q.status] : [ledger],
        );
      });
    },
    async editOccurrence(
      actor: string,
      ledgerId: unknown,
      id: unknown,
      input: unknown,
    ) {
      return mutation(db, actor, 'recurring.update', async (sql) => {
        const ledger = valid(idSchema, ledgerId);
        const l = await ownedLedger(sql, actor, ledger),
          r = await occurrence(sql, ledger, valid(idSchema, id));
        if (!['pending', 'failed'].includes(r.status))
          throw new DomainError('occurrence_not_pending', 409);
        const p = valid(occurrencePatchSchema, input);
        if (p.occurred_on && l.locked_until && p.occurred_on <= l.locked_until)
          throw new DomainError('period_locked', 409);
        if (
          p.entries &&
          (p.entries.length !== r.template.entries.length ||
            p.entries.some(
              (e, i) => e.item_id !== r.template.entries[i]!.item_id,
            ))
        )
          throw new DomainError('invalid_input', 400);
        const t = {
          ...r.template,
          ...(p.memo === undefined ? {} : { memo: p.memo }),
          ...(p.entries ? { entries: p.entries } : {}),
        };
        await sql`UPDATE recurring_occurrences SET occurred_on=${p.occurred_on ?? r.occurred_on},template=${sql.json(t)},status='pending',error_code=NULL WHERE id=${r.id}`;
        return occurrence(sql, ledger, r.id);
      });
    },
    async post(actor: string, ledgerId: unknown, id: unknown) {
      const ledger = valid(idSchema, ledgerId),
        occ = valid(idSchema, id);
      valid(idSchema, actor);
      try {
        return await db.begin(async (sql) => {
          const l = await ownedLedger(sql, actor, ledger),
            r = await occurrence(sql, ledger, occ);
          if (r.status === 'posted') {
            await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},'recurring.post','success')`;
            return r;
          }
          if (r.status === 'skipped')
            throw new DomainError('occurrence_not_pending', 409);
          let error: string | null = null;
          let transaction: string | null = null;
          try {
            await sql.savepoint(async (sp) => {
              const tx = await createTransaction(sp, l, {
                ...r.template,
                occurred_on: r.occurred_on,
              });
              transaction = tx.id;
              await sp`UPDATE transactions SET source_system='recurring',source_id=${r.source_rule_id + ':' + r.occurs_on} WHERE id=${tx.id} AND ledger_id=${ledger}`;
              await sp`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},'transaction.create','success')`;
            });
          } catch (e) {
            if (e instanceof DomainError) error = e.code;
            else throw e;
          }
          if (error)
            await sql`UPDATE recurring_occurrences SET status='failed',error_code=${error},transaction_id=NULL WHERE id=${r.id}`;
          else
            await sql`UPDATE recurring_occurrences SET status='posted',error_code=NULL,transaction_id=${transaction} WHERE id=${r.id}`;
          await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},'recurring.post',${error ? 'error' : 'success'})`;
          return occurrence(sql, ledger, r.id);
        });
      } catch (e) {
        await db`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},'recurring.post',${e instanceof DomainError && e.statusCode === 404 ? 'denied' : 'error'})`;
        throw e;
      }
    },
    async skip(actor: string, ledgerId: unknown, id: unknown) {
      return mutation(db, actor, 'recurring.skip', async (sql) => {
        const ledger = valid(idSchema, ledgerId);
        await ownedLedger(sql, actor, ledger);
        const r = await occurrence(sql, ledger, valid(idSchema, id));
        if (r.status === 'posted')
          throw new DomainError('occurrence_not_pending', 409);
        await sql`UPDATE recurring_occurrences SET status='skipped',error_code=NULL WHERE id=${r.id}`;
        return occurrence(sql, ledger, r.id);
      });
    },
    async bulkPost(actor: string, ledgerId: unknown, input: unknown) {
      const { ids } = valid(occurrenceIdsSchema, input);
      const ledger = valid(idSchema, ledgerId);
      await db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        for (const id of ids) await occurrence(sql, ledger, id);
      });
      const results: RecurringOccurrence[] = [];
      for (const id of ids) results.push(await service.post(actor, ledger, id));
      return results;
    },
    async generate(actor: string, ledgerId: unknown, now = new Date()) {
      const ledger = valid(idSchema, ledgerId),
        today = taipeiToday(now);
      const generated = await mutation(
        db,
        actor,
        'recurring.generate',
        async (sql) => {
          await ownedLedger(sql, actor, ledger);
          const rules = await sql.unsafe<RecurringRule[]>(
            'SELECT ' +
              ruleColumns +
              ' FROM recurring_rules WHERE ledger_id=$1 AND active AND next_on<=$2 ORDER BY id FOR UPDATE',
            [ledger, today],
          );
          let count = 0;
          for (const r of rules) {
            let next = r.next_on;
            while (next && next <= today && (!r.end_on || next <= r.end_on)) {
              const rows =
                await sql`INSERT INTO recurring_occurrences(ledger_id,rule_id,source_rule_id,rule_name,occurs_on,occurred_on,template) VALUES (${ledger},${r.id},${r.id},${r.name},${next},${next},${sql.json(r.template)}) ON CONFLICT(source_rule_id,occurs_on) DO NOTHING RETURNING id`;
              count += rows.length;
              next = nextOccurrence(r, next);
            }
            await sql`UPDATE recurring_rules SET next_on=${next} WHERE id=${r.id}`;
          }
          return count;
        },
      );
      // Recovery also includes pending auto-post rows left by a crashed previous generator; failed rows await user repair.
      const auto = await db<
        { id: string }[]
      >`SELECT o.id FROM recurring_occurrences o JOIN recurring_rules r ON r.id=o.rule_id AND r.ledger_id=o.ledger_id JOIN ledgers l ON l.id=o.ledger_id WHERE o.ledger_id=${ledger} AND l.owner_id=${actor} AND r.active AND r.auto_post AND o.status='pending' ORDER BY o.occurs_on,o.id`;
      for (const r of auto) await service.post(actor, ledger, r.id);
      return { generated, ...(await service.state(actor, ledger)) };
    },
  };
  return service;
}
