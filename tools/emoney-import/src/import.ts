// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '@finmichi/db';
import { assertBalanced } from '@finmichi/core';
import { ImportError, planSchema } from './schema.js';
const optionsSchema = z
  .object({
    ownerSubject: z.string().min(1),
    ledgerName: z.string().trim().min(1).max(160),
    allowDuplicateLedger: z.boolean().default(false),
  })
  .strict();
export type ImportOptions = z.input<typeof optionsSchema>;
export function validatedPlan(input: unknown) {
  const plan = planSchema.parse(input);
  if (plan.report.errors.length) throw new ImportError('import_has_errors');
  const itemKeys = new Set(plan.items.map((i) => i.key));
  if (itemKeys.size !== plan.items.length)
    throw new ImportError('duplicate_item_key');
  const sourceKeys = new Set<string>();
  for (const t of plan.transactions) {
    if (sourceKeys.has(t.source_key))
      throw new ImportError('duplicate_source_key');
    sourceKeys.add(t.source_key);
    assertBalanced(t.entries.map((e) => e.base_amount));
    for (const e of t.entries)
      if (!itemKeys.has(e.item_key)) throw new ImportError('reference_invalid');
  }
  return plan;
}
export async function owner(db: Database, subject: string) {
  const rows =
    await db`SELECT id FROM users WHERE oidc_subject=${subject} LIMIT 2`;
  if (rows.length !== 1)
    throw new ImportError(
      rows.length ? 'owner_subject_ambiguous' : 'owner_not_found',
    );
  return String(rows[0]!.id);
}
export async function applyPlan(
  db: Database,
  input: unknown,
  options: ImportOptions,
) {
  const plan = validatedPlan(input),
    args = optionsSchema.parse(options);
  const actor = await owner(db, args.ownerSubject);
  try {
    return await db.begin(async (sql) => {
      // Serialize owner-wide duplicate checks and ledger creation, including concurrent apply commands.
      await sql`SELECT id FROM users WHERE id=${actor} FOR UPDATE`;
      const duplicates =
        await sql`SELECT DISTINCT l.name FROM import_jobs j JOIN ledgers l ON l.id=j.ledger_id WHERE l.owner_id=${actor} AND j.source_sha256=${plan.source_sha256} AND j.status='imported' ORDER BY l.name`;
      if (duplicates.length && !args.allowDuplicateLedger)
        throw new ImportError('already_imported_for_owner', {
          ledger_names: duplicates.map((r) => String(r.name)),
        });
      const existing =
        await sql`SELECT id FROM ledgers WHERE owner_id=${actor} AND lower(name)=lower(${args.ledgerName})`;
      if (existing.length) throw new ImportError('duplicate_ledger_name');
      const ledger = randomUUID(),
        job = randomUUID();
      await sql`INSERT INTO ledgers(id,owner_id,name,base_currency) VALUES (${ledger},${actor},${args.ledgerName},'TWD')`;
      const storedReport = {
        ...plan.report,
        mapping_sha256: plan.mapping_sha256,
        allow_duplicate_ledger: args.allowDuplicateLedger,
        source_date: plan.source_date,
        exported_at: plan.exported_at,
        system_items: plan.items
          .filter((i) => i.system_created)
          .map((i) => ({ kind: i.kind, name: i.name, system_created: true })),
        staging: plan.staging,
      };
      await sql`INSERT INTO import_jobs(id,ledger_id,source_sha256,source_system,status,report) VALUES (${job},${ledger},${plan.source_sha256},'emoney-mdb','validated',${sql.json(storedReport)})`;
      const itemIds = new Map(plan.items.map((i) => [i.key, randomUUID()])),
        projectIds = new Map(plan.projects.map((i) => [i.key, randomUUID()])),
        payeeIds = new Map(plan.payees.map((i) => [i.key, randomUUID()]));
      const provenance: {
        ledger_id: string;
        import_job_id: string;
        source_table: string;
        source_key: string;
        target_table: string;
        target_id: string;
      }[] = [];
      const provenanceAdd = (
        table: string,
        key: string,
        targetTable: string,
        id: string,
      ) =>
        provenance.push({
          ledger_id: ledger,
          import_job_id: job,
          source_table: table,
          source_key: key,
          target_table: targetTable,
          target_id: id,
        });
      function chunks<T>(rows: T[], size: number) {
        return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) =>
          rows.slice(i * size, (i + 1) * size),
        );
      }
      for (const batch of chunks(plan.items, 500)) {
        const values = batch.map((i) => ({
          id: itemIds.get(i.key)!,
          ledger_id: ledger,
          parent_id: null,
          kind: i.kind,
          name: i.name,
          currency: i.currency,
          non_operating: i.non_operating,
          fixed: i.fixed,
          credit_card: i.credit_card,
          loan: i.loan,
          archived: false,
        }));
        await sql`INSERT INTO items ${sql(values)}`;
      }
      for (const item of plan.items) {
        const id = itemIds.get(item.key)!;
        if (item.parent_key) {
          const parent = itemIds.get(item.parent_key);
          if (!parent) throw new ImportError('reference_invalid');
          await sql`UPDATE items SET parent_id=${parent} WHERE id=${id} AND ledger_id=${ledger}`;
        }
        for (const source of item.source_keys)
          provenanceAdd('ITEM_DATA', source, 'items', id);
        if (item.system_created)
          provenanceAdd('system', item.name, 'items', id);
      }
      for (const [table, records, ids] of [
        ['projects', plan.projects, projectIds],
        ['payees', plan.payees, payeeIds],
      ] as const) {
        if (new Set(records.map((r) => r.key)).size !== records.length)
          throw new ImportError('duplicate_named_key');
        for (const batch of chunks([...records], 500))
          await sql`INSERT INTO ${sql(table)} ${sql(batch.map((r) => ({ id: ids.get(r.key)!, ledger_id: ledger, name: r.name, archived: false })))}`;
        for (const r of records)
          provenanceAdd(
            table === 'projects' ? 'PROJECT_SET' : 'SHOP_DATA',
            r.key,
            table,
            ids.get(r.key)!,
          );
      }
      for (const batch of chunks(plan.rates, 500))
        await sql`INSERT INTO exchange_rates ${sql(batch.map((r) => ({ ledger_id: ledger, rate_date: r.rate_date, from_currency: r.from_currency, to_currency: r.to_currency, rate: r.rate, as_of_source: r.as_of_source })))}`;
      for (const r of plan.rates)
        provenanceAdd('CURRENCY_SET', r.key, 'exchange_rates', r.key);
      for (const batch of chunks(plan.transactions, 500)) {
        const ids = new Map(batch.map((t) => [t.source_key, randomUUID()]));
        await sql`INSERT INTO transactions ${sql(
          batch.map((t) => {
            if (
              (t.project_key && !projectIds.has(t.project_key)) ||
              (t.payee_key && !payeeIds.has(t.payee_key))
            )
              throw new ImportError('reference_invalid');
            return {
              id: ids.get(t.source_key)!,
              ledger_id: ledger,
              occurred_on: t.occurred_on,
              memo: t.memo,
              kind: t.kind,
              invoice_no: '',
              project_id: t.project_key ? projectIds.get(t.project_key)! : null,
              payee_id: t.payee_key ? payeeIds.get(t.payee_key)! : null,
              source_system: 'emoney-mdb',
              source_id: t.source_key,
            };
          }),
        )}`;
        const entries = batch.flatMap((t) =>
          t.entries.map((e, index) => ({
            id: randomUUID(),
            ledger_id: ledger,
            transaction_id: ids.get(t.source_key)!,
            item_id: itemIds.get(e.item_key)!,
            amount: e.amount,
            currency: e.currency,
            exchange_rate: e.exchange_rate,
            base_amount: e.base_amount,
            entry_position: index,
          })),
        );
        for (const entryBatch of chunks(entries, 1000))
          await sql`INSERT INTO transaction_entries ${sql(entryBatch)}`;
        for (const t of batch) {
          const id = ids.get(t.source_key)!,
            opening =
              t.source_key.startsWith('ITEM_DATA:') &&
              t.source_key.endsWith(':opening');
          if (opening)
            provenanceAdd('ITEM_DATA', t.source_key, 'transactions', id);
          else
            for (const source of new Set(
              t.entries.flatMap((e) => e.source_keys),
            ))
              provenanceAdd('MYMONEY_DATA', source, 'transactions', id);
          if (
            t.entries.some(
              (e) =>
                plan.items.find((i) => i.key === e.item_key)?.system_created &&
                plan.items.find((i) => i.key === e.item_key)?.name ===
                  '匯兌尾差',
            )
          )
            provenanceAdd(
              'MYMONEY_DATA',
              t.source_key + ':fx_rounding_residual',
              'transactions',
              id,
            );
        }
      }
      for (const batch of chunks(provenance, 1000))
        await sql`INSERT INTO import_source_records ${sql(batch)}`;
      await sql`UPDATE import_jobs SET status='imported' WHERE id=${job} AND ledger_id=${ledger}`;
      await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},'emoney.import','success')`;
      return {
        ledger_id: ledger,
        import_job_id: job,
        source_sha256: plan.source_sha256,
        imported_count: plan.transactions.length,
      };
    });
  } catch (error) {
    await db`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},'emoney.import','error')`;
    throw error;
  }
}
