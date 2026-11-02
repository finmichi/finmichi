// SPDX-License-Identifier: AGPL-3.0-only
export type CsvValue = string | { numeric: string };
export const csvNumber = (value: string): CsvValue => ({ numeric: value });
export function csvCell(cell: CsvValue): string {
  const value = typeof cell === 'string' ? cell : cell.numeric;
  const trustedNumber =
    typeof cell !== 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
  const safe =
    !trustedNumber && /^[\s\p{Cc}]*[=+@-]/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export const encodeCsv = (rows: CsvValue[][]) =>
  '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
