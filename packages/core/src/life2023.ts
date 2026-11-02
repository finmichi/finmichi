// SPDX-License-Identifier: AGPL-3.0-only
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, ownedLedger, valid, mutation } from './catalog.js';
import {
  idSchema,
  itemCreateSchema,
  namedCreateSchema,
  type Item,
  type NamedRecord,
  type Ledger,
} from './catalog-schemas.js';
import { createTransaction } from './transactions.js';
import { createItem } from './items.js';
import { parseLife2023, normalizedName } from './life2023-parse.js';
import {
  life2023InputSchema,
  type Life2023Input,
  type Life2023Preview,
  type ItemMappingGroup,
  type NamedMappingGroup,
} from './life2023-schemas.js';
import { moneyUnits } from './money.js';
const own = <T>(record: Record<string, T>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;
async function analyze(sql: Transaction, l: Ledger, input: Life2023Input) {
  const parsed = parseLife2023(input);
  const items = await sql<Item[]>`SELECT * FROM items WHERE ledger_id=${l.id}`;
  const payees = await sql<
    NamedRecord[]
  >`SELECT * FROM payees WHERE ledger_id=${l.id}`;
  const projects = await sql<
    NamedRecord[]
  >`SELECT * FROM projects WHERE ledger_id=${l.id}`;
  const itemGroups = new Map<string, ItemMappingGroup>();
  const namedGroups = {
    payees: new Map<string, NamedMappingGroup>(),
    projects: new Map<string, NamedMappingGroup>(),
  };
  for (const row of parsed.rows) {
    if (row.cells.length !== 8) continue;
    for (const [index, field, label] of [
      [1, 'source', '來源項目'],
      [2, 'destination', '目的帳目'],
    ] as const) {
      const name = row.cells[index]!.trim(),
        key = field + ':' + normalizedName(name);
      let group = itemGroups.get(key);
      if (!group) {
        const candidates = items.filter(
          (i) => !i.archived && normalizedName(i.name) === normalizedName(name),
        );
        const selection =
          own(input.item_mappings, key) ??
          (candidates.length === 1
            ? { mode: 'existing' as const, id: candidates[0]!.id }
            : null);
        group = {
          key,
          name,
          field,
          candidates: candidates.map(({ id, name, kind, currency }) => ({
            id,
            name,
            kind,
            currency,
          })),
          selection,
        };
        itemGroups.set(key, group);
      }
      if (!group.selection)
        row.errors.push({ field: label, code: 'mapping_required' });
      else if (group.selection.mode === 'existing') {
        const item = items.find(
          (i) => i.id === (group.selection as { id: string }).id,
        );
        if (!item) throw new DomainError('not_found', 404);
        if (item.archived)
          row.errors.push({ field: label, code: 'archived_resource' });
        else if (item.currency !== l.base_currency)
          row.errors.push({
            field: label,
            code: 'foreign_currency_not_supported',
          });
      } else if (group.selection.mode === 'create') {
        const data = group.selection.data;
        const collision = items.find(
          (i) =>
            i.kind === data.kind &&
            normalizedName(i.name) === normalizedName(data.name),
        );
        if (collision)
          row.errors.push({
            field: label,
            code: collision.archived ? 'archived_resource' : 'duplicate_name',
          });
      }
    }
    for (const [index, table] of [
      [5, 'payees'],
      [6, 'projects'],
    ] as const) {
      const name = row.cells[index]!.trim(),
        key = normalizedName(name);
      if (!name) continue;
      if (!namedGroups[table].has(key)) {
        const records = table === 'payees' ? payees : projects;
        const candidates = records.filter(
          (r) => !r.archived && normalizedName(r.name) === key,
        );
        const selection =
          own(
            table === 'payees' ? input.payee_mappings : input.project_mappings,
            key,
          ) ??
          (candidates.length === 1
            ? { mode: 'existing' as const, id: candidates[0]!.id }
            : { mode: 'create' as const });
        namedGroups[table].set(key, {
          key,
          name,
          candidates: candidates.map(({ id, name }) => ({ id, name })),
          selection,
        });
      }
      const group = namedGroups[table].get(key)!;
      if (group.selection.mode === 'existing') {
        const id = group.selection.id,
          r = (table === 'payees' ? payees : projects).find((r) => r.id === id);
        if (!r) throw new DomainError('not_found', 404);
        if (r.archived)
          row.errors.push({
            field: index === 5 ? '收付人' : '專案代號',
            code: 'archived_resource',
          });
      }
      if (group.selection.mode === 'create') {
        const collision = (table === 'payees' ? payees : projects).find(
          (r) => normalizedName(r.name) === key,
        );
        if (collision)
          row.errors.push({
            field: index === 5 ? '收付人' : '專案代號',
            code: collision.archived ? 'archived_resource' : 'duplicate_name',
          });
      }
    }
    if (row.occurred_on && l.locked_until && row.occurred_on <= l.locked_until)
      row.errors.push({ field: '記錄日期', code: 'period_locked' });
    const a = itemGroups.get(
        'source:' + normalizedName(row.cells[1]!),
      )!.selection,
      b = itemGroups.get(
        'destination:' + normalizedName(row.cells[2]!),
      )!.selection;
    if (
      row.occurred_on &&
      row.amount &&
      a?.mode === 'existing' &&
      b?.mode === 'existing'
    ) {
      const [r] =
        await sql`SELECT EXISTS(SELECT 1 FROM transactions t WHERE t.ledger_id=${l.id} AND t.occurred_on=${row.occurred_on}::text::date AND t.memo=${row.cells[4]!}
    AND (SELECT count(*) FROM transaction_entries e WHERE e.transaction_id=t.id)=2
    AND EXISTS(SELECT 1 FROM transaction_entries e WHERE e.transaction_id=t.id AND e.item_id=${a.id} AND e.currency=${l.base_currency} AND e.amount=-${row.amount}::numeric)
    AND EXISTS(SELECT 1 FROM transaction_entries e WHERE e.transaction_id=t.id AND e.item_id=${b.id} AND e.currency=${l.base_currency} AND e.amount=${row.amount}::numeric)) AS duplicate`;
      row.suspected_duplicate = Boolean(r!.duplicate);
    }
  }
  const creations = new Map<string, string>();
  for (const g of itemGroups.values())
    if (g.selection?.mode === 'create') {
      const data = g.selection.data,
        key = data.kind + ':' + normalizedName(data.name),
        encoded = JSON.stringify(data);
      if (creations.has(key) && creations.get(key) !== encoded)
        throw new DomainError('conflicting_mapping', 400);
      creations.set(key, encoded);
    }
  const [job] =
    await sql`SELECT EXISTS(SELECT 1 FROM import_jobs WHERE ledger_id=${l.id} AND source_sha256=${parsed.source_sha256} AND status='imported') AS imported`;
  const good = parsed.rows.filter((r) => r.errors.length === 0);
  const cents = good.reduce(
    (sum, r) => sum + moneyUnits(r.amount!) / 10000n,
    0n,
  );
  const report: Life2023Preview = {
    ...parsed,
    importable_count: good.length,
    error_count: parsed.rows.length - good.length,
    suspected_duplicate_count: parsed.rows.filter((r) => r.suspected_duplicate)
      .length,
    total_amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
    item_groups: [...itemGroups.values()],
    payee_groups: [...namedGroups.payees.values()],
    project_groups: [...namedGroups.projects.values()],
    pending_creates: {
      items: new Set(
        [...itemGroups.values()]
          .filter((g) => g.selection?.mode === 'create')
          .map((g) =>
            g.selection?.mode === 'create'
              ? g.selection.data.kind +
                ':' +
                normalizedName(g.selection.data.name)
              : '',
          ),
      ).size,
      payees: [...namedGroups.payees.values()].filter(
        (g) => g.selection.mode === 'create',
      ).length,
      projects: [...namedGroups.projects.values()].filter(
        (g) => g.selection.mode === 'create',
      ).length,
    },
    already_imported: Boolean(job!.imported),
  };
  return { report, good, itemGroups, namedGroups };
}
export function life2023Service(db: Database) {
  return {
    async preview(
      actor: string,
      ledgerId: unknown,
      input: unknown,
    ): Promise<Life2023Preview> {
      valid(idSchema, actor);
      const ledger = valid(idSchema, ledgerId);
      return (await db.begin(async (sql) => {
        const l = await ownedLedger(sql, actor, ledger),
          data = valid(life2023InputSchema, input);
        return (await analyze(sql, l, data)).report;
      })) as Life2023Preview;
    },
    async confirm(actor: string, ledgerId: unknown, input: unknown) {
      return mutation(db, actor, 'life2023.import', async (sql) => {
        const ledger = valid(idSchema, ledgerId);
        const l = await ownedLedger(sql, actor, ledger),
          data = valid(life2023InputSchema, input);
        const { report, good, itemGroups, namedGroups } = await analyze(
          sql,
          l,
          data,
        );
        if (report.already_imported)
          throw new DomainError('already_imported', 409);
        if (report.error_count && !data.skip_invalid)
          throw new DomainError('import_has_errors', 400);
        if (!good.length) throw new DomainError('no_importable_rows', 400);
        const storedReport = {
          encoding: report.encoding,
          skip_invalid: data.skip_invalid,
          imported_lines: good.map((r) => r.line),
          skipped_lines: report.rows
            .filter((r) => r.errors.length)
            .map((r) => ({
              line: r.line,
              errors: r.errors.map(({ field, code }) => ({ field, code })),
            })),
          suspected_duplicate_lines: good
            .filter((r) => r.suspected_duplicate)
            .map((r) => r.line),
        };
        const [job] =
          await sql`INSERT INTO import_jobs(ledger_id,source_sha256,source_system,status,report) VALUES (${ledger},${report.source_sha256},'life2023-csv','validated',${sql.json(storedReport)}) RETURNING id`;
        const itemIds = new Map<string, string>(),
          createdItems = new Map<string, string>();
        async function itemId(key: string) {
          const cached = itemIds.get(key);
          if (cached) return cached;
          const group = itemGroups.get(key)!,
            choice = group.selection!;
          let id: string;
          if (choice.mode === 'existing') id = choice.id;
          else {
            const d = valid(itemCreateSchema, {
                ...choice.data,
                currency: l.base_currency,
                archived: false,
              }),
              signature = d.kind + ':' + normalizedName(d.name);
            id =
              createdItems.get(signature) ??
              (await createItem(sql, ledger, d)).id;
            createdItems.set(signature, id);
          }
          itemIds.set(key, id);
          return id;
        }
        const namedIds = {
          payees: new Map<string, string | null>(),
          projects: new Map<string, string | null>(),
        };
        async function namedId(table: 'payees' | 'projects', name: string) {
          const key = normalizedName(name);
          if (!key) return null;
          if (namedIds[table].has(key)) return namedIds[table].get(key)!;
          const group = namedGroups[table].get(key)!,
            choice = group.selection;
          let id: string | null;
          if (choice.mode === 'blank') id = null;
          else if (choice.mode === 'existing') id = choice.id;
          else {
            const d = valid(namedCreateSchema, { name: group.name });
            const [r] =
              await sql`INSERT INTO ${sql(table)} ${sql({ ...d, ledger_id: ledger })} RETURNING id`;
            id = String(r!.id);
          }
          namedIds[table].set(key, id);
          return id;
        }
        for (const row of good) {
          const transaction = await createTransaction(
            sql,
            l,
            {
              occurred_on: row.occurred_on!,
              memo: row.cells[4]!,
              invoice_no: row.cells[7]!,
              payee_id: await namedId('payees', row.cells[5]!),
              project_id: await namedId('projects', row.cells[6]!),
              entries: [
                {
                  item_id: await itemId(
                    'source:' + normalizedName(row.cells[1]!),
                  ),
                  amount: '-' + row.amount!,
                },
                {
                  item_id: await itemId(
                    'destination:' + normalizedName(row.cells[2]!),
                  ),
                  amount: row.amount!,
                },
              ],
            },
            false,
            false,
            true,
          );
          await sql`UPDATE transactions SET source_system='life2023-csv',source_id=${String(job!.id) + ':' + row.line} WHERE id=${transaction.id} AND ledger_id=${ledger}`;
          await sql`INSERT INTO import_source_records(ledger_id,import_job_id,source_table,source_key,target_table,target_id) VALUES (${ledger},${String(job!.id)},'csv',${String(row.line)},'transactions',${transaction.id})`;
        }
        await sql`UPDATE import_jobs SET status='imported' WHERE id=${String(job!.id)} AND ledger_id=${ledger}`;
        return {
          import_job_id: String(job!.id),
          source_sha256: report.source_sha256,
          imported_count: good.length,
          skipped_count: report.error_count,
        };
      });
    },
  };
}
