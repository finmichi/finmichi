// SPDX-License-Identifier: AGPL-3.0-only
import { type CsvValue, csvNumber as numeric, encodeCsv } from './csv.js';
import type { Database } from '@finmichi/db';
import { z } from 'zod';
import { roundHalfUp } from './money.js';
import { ledgerService, valid } from './catalog.js';
import { filterSchema } from './query-schemas.js';
import { queryService } from './queries.js';
import { transactionDirection } from './query-format.js';
const schema = filterSchema.safeExtend({
  format: z.enum(['detail', 'entries']).default('detail'),
});
const kindNames = {
  income: '收入',
  expense: '支出',
  transfer: '轉帳',
  adjustment: '調整',
};
export { csvCell } from './csv.js';
export async function queryCsv(
  db: Database,
  actor: string,
  ledger: string,
  input: unknown,
) {
  await ledgerService(db).get(actor, ledger);
  const { format, ...filters } = valid(schema, input);
  const rows = await queryService(db).all(actor, ledger, filters);
  const selected = Boolean(filters.item_id);
  const data: CsvValue[][] =
    format === 'detail'
      ? [
          [
            '日期',
            '類別',
            '摘要',
            '發票號碼',
            '收付人',
            '專案',
            '交易金額',
            ...(selected ? ['所選科目淨額'] : []),
            '來源 → 目的',
          ],
          ...rows.map((r) => [
            r.occurred_on,
            kindNames[r.kind],
            r.memo ?? '',
            r.invoice_no ?? '',
            r.payee_name ?? '',
            r.project_name ?? '',
            numeric(roundHalfUp(r.transaction_amount, 2)),
            ...(selected
              ? [numeric(roundHalfUp(r.selected_net_amount ?? '0', 2))]
              : []),
            transactionDirection(r),
          ]),
        ]
      : [
          [
            '交易 id',
            '日期',
            '科目',
            'kind',
            '原幣金額',
            '幣別',
            '匯率',
            'base_amount',
          ],
          ...rows.flatMap((r) =>
            r.entries.map((e) => [
              r.id,
              r.occurred_on,
              e.item_name,
              e.item_kind,
              numeric(e.amount),
              e.currency,
              numeric(e.exchange_rate),
              numeric(roundHalfUp(e.base_amount, 2)),
            ]),
          ),
        ];
  return encodeCsv(data);
}
