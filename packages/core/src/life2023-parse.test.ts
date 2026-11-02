// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import iconv from 'iconv-lite';
import { parseLife2023 } from './life2023-parse.js';
import { life2023Headers, life2023InputSchema } from './life2023-schemas.js';
const text = (data: string[]) =>
  life2023Headers.join(',') +
  '\r\n' +
  data.map((s) => '"' + s.replaceAll('"', '""') + '"').join(',') +
  '\r\n';
const row = [
  '2026/10/17',
  '現金',
  '餐費',
  '1,234.50',
  '"合成",逗號\n換行',
  '',
  '',
  '',
];
const input = (bytes: Buffer, encoding = 'auto') =>
  life2023InputSchema.parse({
    file_base64: bytes.toString('base64'),
    encoding,
  });
it('UTF8 BOM, UTF8 without BOM and Big5 decode fixed headers and physical multiline start line', () => {
  for (const [bytes, encoding] of [
    [Buffer.from(text(row)), 'utf-8'],
    [Buffer.from('\uFEFF' + text(row)), 'utf-8'],
    [iconv.encode(text(row), 'cp950'), 'big5'],
  ] as const) {
    const parsed = parseLife2023(input(bytes));
    expect(parsed.encoding).toBe(encoding);
    expect(parsed.rows[0]).toMatchObject({
      line: 2,
      occurred_on: '2026-10-17',
      amount: '1234.50',
      errors: [],
    });
    expect(parsed.rows[0]!.cells[4]).toBe(row[4]);
  }
});
it.each(['0', '-1', '1.001', 'NaN', 'Infinity', '1e3', '100000000000000', ''])(
  'invalid amount %s remains a row error',
  (amount) => {
    const r = parseLife2023(
      input(Buffer.from(text(row.map((v, i) => (i === 3 ? amount : v))))),
    ).rows[0]!;
    expect(r.errors).toContainEqual({
      field: '異動金額',
      code: 'invalid_amount',
    });
    expect(r.amount).toBeNull();
  },
);
it.each(['115/10/17', '2026/02/30', '2026-2-01', '2026/13/01'])(
  'invalid date %s never defaults',
  (date) => {
    const r = parseLife2023(
      input(Buffer.from(text(row.map((v, i) => (i === 0 ? date : v))))),
    ).rows[0]!;
    expect(r.occurred_on).toBeNull();
    expect(r.errors).toContainEqual({
      field: '記錄日期',
      code: 'invalid_date',
    });
  },
);
it('invalid header, broken quotes, invalid encoding and empty files reject explicitly', () => {
  for (const data of ['', life2023Headers.join(','), 'a,b\r\n', '"broken'])
    expect(() => parseLife2023(input(Buffer.from(data)))).toThrow();
  expect(() =>
    parseLife2023(input(iconv.encode(text(row), 'cp950'), 'utf-8')),
  ).toThrow('encoding_required');
  expect(() => parseLife2023(input(Buffer.from([0xff, 0x81])))).toThrow(
    'encoding_required',
  );
});
