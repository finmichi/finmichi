// SPDX-License-Identifier: AGPL-3.0-only
import { budgetFiltersFromLocation, budgetFiltersUrl } from './report-state';
import { describe, it, expect } from 'vitest';
import {
  incomeFiltersFromLocation,
  categoryFiltersFromLocation,
  incomeFiltersUrl,
  categoryFiltersUrl,
} from './report-state';
const today = '2026-10-18';
describe('report URL projections', () => {
  it('restores income period/grain and projects away unknown API fields', () => {
    expect(
      incomeFiltersFromLocation(
        '/reports/income-summary?date_from=2026-08-01&date_to=2026-10-31&grain=quarter&owner_id=ignored&limit=1',
        today,
      ),
    ).toEqual({
      date_from: '2026-08-01',
      date_to: '2026-10-31',
      grain: 'quarter',
    });
  });
  it('restores every category filter without leaking another report field', () => {
    expect(
      categoryFiltersFromLocation(
        '/reports/category-statistics?date_from=2026-08-01&date_to=2026-10-31&kind=income&non_operating=non_operating&fixed=variable&grain=year',
        today,
      ),
    ).toEqual({
      date_from: '2026-08-01',
      date_to: '2026-10-31',
      kind: 'income',
      non_operating: 'non_operating',
      fixed: 'variable',
    });
  });
  it('defaults invalid calendar dates/enums and missing fields deterministically', () => {
    expect(
      incomeFiltersFromLocation(
        '/reports/income-summary?date_from=2026-02-30&grain=invalid',
        today,
      ),
    ).toEqual({ date_from: '2026-10-01', date_to: today, grain: 'month' });
    expect(
      categoryFiltersFromLocation(
        '/reports/category-statistics?kind=transfer&fixed=bogus&non_operating=bogus',
        today,
      ),
    ).toEqual({
      date_from: '2026-10-01',
      date_to: today,
      kind: 'expense',
      non_operating: 'all',
      fixed: 'all',
    });
  });
  it('serializes only explicit income fields and round trips', () => {
    const fields = {
      date_from: '2026-08-01',
      date_to: '2026-10-31',
      grain: 'year',
    };
    const url = incomeFiltersUrl({
      ...fields,
      owner_id: 'ignored',
      fixed: 'all',
    });
    expect([...new URLSearchParams(url.split('?')[1]).keys()]).toEqual([
      'date_from',
      'date_to',
      'grain',
    ]);
    expect(incomeFiltersFromLocation(url, today)).toEqual(fields);
  });
  it('serializes only explicit category fields and round trips', () => {
    const fields = {
      date_from: '2026-08-01',
      date_to: '2026-10-31',
      kind: 'income',
      non_operating: 'operating',
      fixed: 'fixed',
    };
    const url = categoryFiltersUrl({
      ...fields,
      owner_id: 'ignored',
      cursor: 'ignored',
    });
    expect([...new URLSearchParams(url.split('?')[1]).keys()]).toEqual([
      'date_from',
      'date_to',
      'kind',
      'non_operating',
      'fixed',
    ]);
    expect(categoryFiltersFromLocation(url, today)).toEqual(fields);
  });
});

it('budget report restores only allowed criteria and drops unknown URL fields', () => {
  const q = budgetFiltersFromLocation(
    '/reports/budget-vs-actual?year=2026&grain=quarter&kind=income&non_operating=non_operating&fixed=variable&unknown=1',
    '2025-01-01',
  );
  expect(q).toEqual({
    year: '2026',
    grain: 'quarter',
    kind: 'income',
    non_operating: 'non_operating',
    fixed: 'variable',
  });
  expect(budgetFiltersUrl({ ...q, unknown: '1' })).not.toContain('unknown');
  expect(budgetFiltersFromLocation(budgetFiltersUrl(q), '2025-01-01')).toEqual(
    q,
  );
});
it('budget report invalid year/grain/category/flags use safe defaults', () => {
  expect(
    budgetFiltersFromLocation(
      '?year=0&grain=day&kind=asset&non_operating=x&fixed=x',
      '2026-10-18',
    ),
  ).toEqual({
    year: '2026',
    grain: 'month',
    kind: 'expense',
    non_operating: 'all',
    fixed: 'all',
  });
});

it('budget period defaults to current month/quarter, first period for other years, restores valid URLs only', async () => {
  const { budgetPeriodFromLocation: p } = await import('./report-state');
  const q = { year: '2026', grain: 'month' };
  expect(p('', q, '2026-10-18')).toBe('2026-10-01');
  expect(p('', { ...q, grain: 'quarter' }, '2026-10-18')).toBe('2026-10-01');
  expect(p('', { ...q, year: '2025' }, '2026-10-18')).toBe('2025-01-01');
  expect(p('?period=2026-03-01', q, '2026-10-18')).toBe('2026-03-01');
  for (const bad of ['2026-02-30', '2025-03-01', '2026-03-02'])
    expect(p('?period=' + bad, q, '2026-10-18')).toBe('2026-10-01');
  expect(
    p('?period=2026-03-01', { ...q, grain: 'quarter' }, '2026-10-18'),
  ).toBe('2026-10-01');
  expect(p('', { ...q, grain: 'year' }, '2026-10-18')).toBe('2026-01-01');
});

import {
  extendedFiltersFromLocation,
  extendedFiltersUrl,
  accountFiltersFromLocation,
  flowViewFromLocation,
} from './report-state';
it('extended reports use explicit URL allowlists, restore supported filters and reject unsupported future views', () => {
  const q = extendedFiltersFromLocation(
    '/reports/profit-loss?date_from=2026-01-01&grain=quarter&fixed=fixed&secret=x',
    '2026-10-19',
    true,
  );
  expect(q).toEqual({
    date_from: '2026-01-01',
    date_to: '2026-10-19',
    grain: 'quarter',
  });
  expect(
    extendedFiltersUrl('profit-loss', { ...q, secret: 'x' }),
  ).not.toContain('secret');
  expect(flowViewFromLocation('/reports/flow?view=forecast')).toBe(
    'net-worth-flow',
  );
  expect(
    accountFiltersFromLocation(
      '/reports/flow?item_id=bad&unexpected=x',
      '2026-10-19',
    ),
  ).toEqual({ date_from: '2026-10-01', date_to: '2026-10-19', item_id: '' });
  expect(
    extendedFiltersFromLocation(
      '/reports/profit-loss?grain=day',
      '2026-10-19',
      true,
    ).grain,
  ).toBe('month');
});

it('cash forecast URL restores only approved conditions and rejects unknown view/parameters', async () => {
  const {
    forecastFiltersFromLocation,
    extendedFiltersUrl,
    flowViewFromLocation,
  } = await import('./report-state');
  const id = '00000000-0000-4000-8000-000000000001';
  const q = forecastFiltersFromLocation(
    `/reports/flow?view=cash-forecast&accounts=${id},bad,${id}&horizon_days=90&threshold=-1234.50&owner_id=unknown&date_to=2026-12-31`,
  );
  expect(q).toEqual({
    accounts: id,
    horizon_days: '90',
    threshold: '-1234.50',
  });
  expect(extendedFiltersUrl('flow', q, 'cash-forecast')).toBe(
    `/reports/flow?accounts=${id}&horizon_days=90&threshold=-1234.50&view=cash-forecast`,
  );
  expect(forecastFiltersFromLocation('?horizon_days=31&threshold=NaN')).toEqual(
    { horizon_days: '30', threshold: '0' },
  );
  expect(flowViewFromLocation('?view=cash-forecast')).toBe('cash-forecast');
  expect(flowViewFromLocation('?view=write')).toBe('net-worth-flow');
  expect(
    extendedFiltersUrl(
      'flow',
      { accounts: '', horizon_days: '30', threshold: '0' },
      'cash-forecast',
    ),
  ).not.toContain('accounts=');
});
