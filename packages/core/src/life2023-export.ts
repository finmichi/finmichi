// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from '@finmichi/db';
import { idSchema } from './catalog-schemas.js';
import { ownedLedger, valid } from './catalog.js';
import { allQueryRows } from './queries.js';
import { encodeCsv, csvNumber, type CsvValue } from './csv.js';
import { roundHalfUp } from './money.js';
import { life2023Headers, type Life2023Export } from './life2023-schemas.js';
export async function life2023Export(
  db: Database,
  actor: string,
  ledgerId: unknown,
  input: unknown,
): Promise<Life2023Export> {
  const ledger = valid(idSchema, ledgerId);
  return (await db.begin(async (sql) => {
    const l = await ownedLedger(sql, actor, ledger),
      transactions = await allQueryRows(sql, actor, ledger, input);
    const rows: CsvValue[][] = [[...life2023Headers]],
      counts = { multiple_entries: 0, foreign_currency: 0 };
    for (const tx of transactions) {
      if (tx.entries.length !== 2) {
        counts.multiple_entries++;
        continue;
      }
      if (tx.entries.some((e) => e.currency !== l.base_currency)) {
        counts.foreign_currency++;
        continue;
      }
      const source = tx.entries.find((e) => e.amount.startsWith('-'))!,
        destination = tx.entries.find((e) => !e.amount.startsWith('-'))!;
      rows.push([
        tx.occurred_on.replaceAll('-', '/'),
        source.item_name,
        destination.item_name,
        csvNumber(roundHalfUp(destination.amount, 2)),
        tx.memo,
        tx.payee_name ?? '',
        tx.project_name ?? '',
        tx.invoice_no,
      ]);
    }
    return {
      csv: encodeCsv(rows),
      exported_count: rows.length - 1,
      skipped_count: counts.multiple_entries + counts.foreign_currency,
      skip_reasons: Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([code, count]) => ({
          code: code as 'multiple_entries' | 'foreign_currency',
          count,
        })),
    };
  })) as Life2023Export;
}
