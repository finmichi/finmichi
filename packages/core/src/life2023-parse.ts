// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import { DomainError } from './catalog.js';
import {
  life2023Headers,
  type Life2023Input,
  type ImportRow,
} from './life2023-schemas.js';
import { dateSchema } from './transaction-schemas.js';
export const normalizedName = (value: string) => value.trim().toLowerCase();
export function parseLife2023(input: Life2023Input) {
  const bytes = Buffer.from(input.file_base64, 'base64');
  if (
    bytes.length > 4 * 1024 * 1024 ||
    bytes.toString('base64') !== input.file_base64
  )
    throw new DomainError('invalid_csv', 400);
  let encoding: 'utf-8' | 'big5' = input.encoding === 'big5' ? 'big5' : 'utf-8';
  let text = '';
  if (input.encoding !== 'big5') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      if (input.encoding === 'utf-8')
        throw new DomainError('encoding_required', 400);
      encoding = 'big5';
    }
  }
  if (encoding === 'big5') {
    text = iconv.decode(bytes, 'cp950');
    if (!iconv.encode(text, 'cp950').equals(bytes))
      throw new DomainError('encoding_required', 400);
  }
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(text, {
      bom: true,
      info: true,
      relax_column_count: true,
      max_record_size: 32768,
    }) as unknown as typeof records;
  } catch {
    throw new DomainError('invalid_csv', 400);
  }
  const header = records.shift();
  if (
    !header ||
    header.record.length !== 8 ||
    !header.record.every((v, i) => v === life2023Headers[i])
  )
    throw new DomainError('invalid_csv_header', 400);
  if (records.length === 0 || records.length > 10000)
    throw new DomainError('csv_row_limit', 400);
  let previousLine = header.info.lines;
  const rows: ImportRow[] = records.map(({ record: cells, info }) => {
    const row: ImportRow = {
      line: previousLine + 1,
      cells,
      occurred_on: null,
      amount: null,
      errors: [],
      suspected_duplicate: false,
    };
    previousLine = info.lines;
    if (cells.length !== 8) {
      row.errors.push({ field: 'row', code: 'invalid_column_count' });
      return row;
    }
    const date = cells[0]!;
    const dateText = /^\d{4}\/\d{2}\/\d{2}$/.test(date)
      ? date.replaceAll('/', '-')
      : date;
    if (!dateSchema.safeParse(dateText).success)
      row.errors.push({ field: '記錄日期', code: 'invalid_date' });
    else row.occurred_on = dateText;
    const amount = cells[3]!.trim().replaceAll(',', '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || amount.length > 30)
      row.errors.push({ field: '異動金額', code: 'invalid_amount' });
    else {
      const [whole, fraction = ''] = amount.split('.');
      const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
      if (cents === 0n || cents >= 10000000000000000n)
        row.errors.push({ field: '異動金額', code: 'invalid_amount' });
      else
        row.amount = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
    }
    for (const [i, field, max, required] of [
      [1, '來源項目', 200, true],
      [2, '目的帳目', 200, true],
      [4, '摘要', 2000, false],
      [5, '收付人', 200, false],
      [6, '專案代號', 200, false],
      [7, '發票號碼', 100, false],
    ] as const)
      if (cells[i]!.length > max || (required && !cells[i]!.trim()))
        row.errors.push({ field, code: 'invalid_text' });
    return row;
  });
  return {
    rows,
    encoding,
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
