// SPDX-License-Identifier: AGPL-3.0-only
export const emptyFilters = {
  date_from: '',
  date_to: '',
  item_id: '',
  project_id: '',
  payee_id: '',
  keyword: '',
  amount_min: '',
  amount_max: '',
  kind: '',
};
export const cleanFilters = (
  filters: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.keys(emptyFilters)
      .map((k) => [k, (filters[k] ?? '').trim()] as const)
      .filter(([, v]) => v !== ''),
  );
export function filtersFromLocation(location: string) {
  const params = new URLSearchParams(location.split('?')[1] ?? '');
  return { ...emptyFilters, ...cleanFilters(Object.fromEntries(params)) };
}
export const filtersUrl = (filters: Record<string, string>) => {
  const q = new URLSearchParams(cleanFilters(filters)).toString();
  return '/transactions' + (q ? '?' + q : '');
};
