// SPDX-License-Identifier: AGPL-3.0-only
import { formatDate } from './format';
const incomeKeys = ['date_from', 'date_to', 'grain', 'project_id'] as const;
const categoryKeys = [
  'date_from',
  'date_to',
  'kind',
  'non_operating',
  'fixed',
  'project_id',
] as const;
const projectFilter = (p: URLSearchParams) => {
  const id = p.get('project_id');
  return id && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
    ? { project_id: id }
    : {};
};
const validDate = (value: string) => formatDate(value) !== '—';
const read = (location: string) =>
  new URLSearchParams(location.split('?')[1] ?? '');
const choose = (
  value: string | null,
  values: readonly string[],
  fallback: string,
) => (value !== null && values.includes(value) ? value : fallback);
const date = (value: string | null, fallback: string) =>
  value !== null && validDate(value) ? value : fallback;
export function incomeFiltersFromLocation(location: string, today: string) {
  const p = read(location);
  return {
    date_from: date(p.get('date_from'), today.slice(0, 7) + '-01'),
    date_to: date(p.get('date_to'), today),
    grain: choose(p.get('grain'), ['day', 'month', 'quarter', 'year'], 'month'),
    ...projectFilter(p),
  };
}
export function categoryFiltersFromLocation(location: string, today: string) {
  const p = read(location);
  return {
    date_from: date(p.get('date_from'), today.slice(0, 7) + '-01'),
    date_to: date(p.get('date_to'), today),
    ...projectFilter(p),
    kind: choose(p.get('kind'), ['income', 'expense'], 'expense'),
    non_operating: choose(
      p.get('non_operating'),
      ['all', 'operating', 'non_operating'],
      'all',
    ),
    fixed: choose(p.get('fixed'), ['all', 'fixed', 'variable'], 'all'),
  };
}
// Explicit allowlists are used both when restoring location and producing URLs.
const url = (
  page: string,
  keys: readonly string[],
  filters: Record<string, string>,
) =>
  '/reports/' +
  page +
  '?' +
  new URLSearchParams(
    keys
      .filter((k) => !['accounts', 'project_id'].includes(k) || !!filters[k])
      .map((k) => [k, filters[k] ?? '']),
  ).toString();
export const incomeFiltersUrl = (filters: Record<string, string>) =>
  url('income-summary', incomeKeys, filters);
export const categoryFiltersUrl = (filters: Record<string, string>) =>
  url('category-statistics', categoryKeys, filters);

export function budgetFiltersFromLocation(location: string, today: string) {
  const p = read(location),
    year = p.get('year');
  return {
    year: year && /^[1-9]\d{0,3}$/.test(year) ? year : today.slice(0, 4),
    grain: choose(p.get('grain'), ['month', 'quarter', 'year'], 'month'),
    kind: choose(p.get('kind'), ['income', 'expense'], 'expense'),
    non_operating: choose(
      p.get('non_operating'),
      ['all', 'operating', 'non_operating'],
      'all',
    ),
    fixed: choose(p.get('fixed'), ['all', 'fixed', 'variable'], 'all'),
  };
}
export const budgetFiltersUrl = (filters: Record<string, string>) =>
  url(
    'budget-vs-actual',
    ['year', 'grain', 'kind', 'non_operating', 'fixed'],
    filters,
  );

export function budgetPeriodFromLocation(
  location: string,
  filters: { year: string; grain: string },
  today: string,
) {
  const month =
    filters.year === today.slice(0, 4) ? Number(today.slice(5, 7)) : 1;
  const firstMonth =
    filters.grain === 'year'
      ? 1
      : filters.grain === 'quarter'
        ? Math.floor((month - 1) / 3) * 3 + 1
        : month;
  const fallback = `${filters.year.padStart(4, '0')}-${String(firstMonth).padStart(2, '0')}-01`;
  const selected = read(location).get('period');
  if (
    !selected ||
    !validDate(selected) ||
    selected.slice(0, 4) !== filters.year.padStart(4, '0') ||
    !selected.endsWith('-01')
  )
    return fallback;
  const m = Number(selected.slice(5, 7));
  return (filters.grain === 'year' && m !== 1) ||
    (filters.grain === 'quarter' && (m - 1) % 3 !== 0)
    ? fallback
    : selected;
}

export function extendedFiltersFromLocation(
  location: string,
  today: string,
  profit = false,
) {
  const p = read(location),
    base = incomeFiltersFromLocation(location, today);
  return {
    date_from: base.date_from,
    date_to: base.date_to,
    grain: choose(
      p.get('grain'),
      profit
        ? ['month', 'quarter', 'year']
        : ['day', 'month', 'quarter', 'year'],
      'month',
    ),
  };
}
export function flowViewFromLocation(location: string) {
  return choose(
    read(location).get('view'),
    ['net-worth-flow', 'account-ledger', 'cash-forecast'],
    'net-worth-flow',
  );
}
export function accountFiltersFromLocation(location: string, today: string) {
  const p = read(location),
    dates = incomeFiltersFromLocation(location, today),
    id = p.get('item_id');
  return {
    date_from: dates.date_from,
    date_to: dates.date_to,
    item_id:
      id && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? id : '',
  };
}
export function extendedFiltersUrl(
  page: 'profit-loss' | 'flow',
  filters: Record<string, string>,
  view = 'net-worth-flow',
) {
  const keys =
    page === 'profit-loss'
      ? ['date_from', 'date_to', 'grain']
      : view === 'cash-forecast'
        ? ['accounts', 'horizon_days', 'threshold']
        : view === 'account-ledger'
          ? ['date_from', 'date_to', 'item_id']
          : ['date_from', 'date_to', 'grain'];
  return url(page, keys, filters) + (page === 'flow' ? '&view=' + view : '');
}

export function forecastFiltersFromLocation(location: string) {
  const p = read(location),
    raw = p.get('accounts') ?? '',
    threshold = p.get('threshold') ?? '0';
  const accounts = raw
    .split(',')
    .filter((id) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id));
  return {
    ...(accounts.length ? { accounts: [...new Set(accounts)].join(',') } : {}),
    horizon_days: choose(
      p.get('horizon_days'),
      ['30', '60', '90', '180', '366'],
      '30',
    ),
    threshold: /^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(threshold)
      ? threshold
      : '0',
  };
}

export function projectFiltersFromLocation(location: string, today: string) {
  const p = read(location),
    id = p.get('project');
  return {
    date_from: date(p.get('date_from'), today.slice(0, 4) + '-01-01'),
    date_to: date(p.get('date_to'), today),
    include_archived: choose(
      p.get('include_archived'),
      ['true', 'false'],
      'false',
    ),
    project:
      id && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? id : '',
  };
}
export function projectFiltersUrl(filters: Record<string, string>) {
  const p = new URLSearchParams();
  for (const k of ['date_from', 'date_to', 'include_archived', 'project'])
    if (filters[k]) p.set(k, filters[k]!);
  return '/reports/projects?' + p;
}
