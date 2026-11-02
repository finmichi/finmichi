// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { csvCell } from './query-csv.js';
it('trusted numeric columns require a strict decimal and preserve negative numbers', () => {
  for (const value of ['-1000.00', '0', '12.50'])
    expect(csvCell({ numeric: value })).toBe('"' + value + '"');
  for (const value of [
    '-1+1',
    '=SUM(A1)',
    '@x',
    '  =SUM(A1)',
    '\u0001=SUM(A1)',
  ])
    expect(csvCell({ numeric: value })).toBe('"\'' + value + '"');
});
it('text provenance always retains formula protection, including a numeric-looking memo', () => {
  for (const value of [
    '-1+1',
    '=SUM(A1)',
    '@x',
    '  =SUM(A1)',
    '\u0001=SUM(A1)',
    '-123',
    '+1',
  ])
    expect(csvCell(value)).toBe('"\'' + value + '"');
});
