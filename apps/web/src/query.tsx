// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { applyQuerySearchFocus } from './design/location';
import { LoadingState, EmptyState, notify } from './design/feedback';
import type { Life2023Export } from '@finmichi/core/life2023-schemas';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Group,
  Menu,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { Item, Ledger, NamedRecord } from '@finmichi/core/catalog-schemas';
import type {
  ItemSummary,
  QueryPage,
  QuerySummary,
} from '@finmichi/core/query-schemas';
import { api, errorMessage, apiErrorMessage } from './api';
import { TransactionList, kindNames } from './design/transaction-list';
import { formatMoney } from './design/format';
import { negate } from './design/display-math';
import {
  cleanFilters,
  emptyFilters,
  filtersFromLocation,
  filtersUrl,
} from './design/query-state';
import { navigate, useLocation, openEntry } from './design/location';
import { EdgeScroll } from './design/edge-scroll';
import { BackToTop } from './design/back-to-top';
import { useTransactionRevision } from './design/data-revision';
import { projectReportText } from './project-report-messages';
import { queryProfit } from './design/query-profit';
export function queryParams(filters: Record<string, string>) {
  return new URLSearchParams(filters).toString();
}
function tree(rows: ItemSummary[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string | null, ItemSummary[]>();
  for (const r of rows) {
    const parent = r.parent_id && byId.has(r.parent_id) ? r.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const pending = (children.get(null) ?? [])
      .map((row) => ({ row, depth: 0 }))
      .reverse(),
    out: { row: ItemSummary; depth: number }[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    out.push(node);
    for (const child of [...(children.get(node.row.id) ?? [])].reverse())
      pending.push({ row: child, depth: node.depth + 1 });
  }
  return out;
}

export function TransactionQuery({ ledger }: { ledger: Ledger }) {
  const revision = useTransactionRevision();
  const base = `/api/ledgers/${ledger.id}`,
    path = base + '/transactions',
    location = useLocation(),
    appliedKey = queryParams(cleanFilters(filtersFromLocation(location)));
  const [draft, setDraft] = useState(() => filtersFromLocation(location)),
    [view, setView] = useState('detail'),
    [group, setGroup] = useState('item'),
    [natural, setNatural] = useState(true);
  const [items, setItems] = useState<Item[]>([]),
    [payees, setPayees] = useState<NamedRecord[]>([]),
    [projects, setProjects] = useState<NamedRecord[]>([]);
  const [page, setPage] = useState<QueryPage | null>(null),
    [summary, setSummary] = useState<QuerySummary | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [size, setSize] = useState('25'),
    [cursorState, setCursorState] = useState<{
      key: string;
      value: string | null;
    }>({ key: '', value: null }),
    [advanced, setAdvanced] = useState(false),
    [retry, setRetry] = useState(0),
    [sort, setSort] = useState<'date-desc' | 'date-asc' | 'amount-desc'>(
      'date-desc',
    );
  const cursorScope = path + '?' + appliedKey + '&revision=' + revision;
  const cursor = cursorState.key === cursorScope ? cursorState.value : null;
  function setCursor(value: string | null) {
    setCursorState({ key: cursorScope, value });
  }
  const mobile = useMediaQuery('(max-width: 899px)');
  const clean = cleanFilters(draft),
    applied = Object.fromEntries(new URLSearchParams(appliedKey)),
    dirty = queryParams(clean) !== appliedKey;
  useEffect(() => {
    setDraft(filtersFromLocation(location));
    setCursor(null);
  }, [appliedKey]);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<Item[]>(base + '/items?include_archived=true'),
      api<NamedRecord[]>(base + '/payees?include_archived=true'),
      api<NamedRecord[]>(base + '/projects?include_archived=true'),
    ])
      .then(([a, p, j]) => {
        if (live) {
          setItems(a);
          setPayees(p);
          setProjects(j);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [base, revision]);
  const previousRevision = useRef(revision),
    loadedScope = useRef(''),
    pendingScroll = useRef<{ scope: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const restore = pendingScroll.current;
    if (
      busy ||
      !page ||
      !restore ||
      restore.scope !== path + '?' + appliedKey + '&size=' + size
    )
      return;
    const viewport =
      document.querySelector<HTMLElement>('[aria-label="主內容"]');
    if (viewport) viewport.scrollTop = restore.top;
    pendingScroll.current = null;
  }, [busy, page, path, appliedKey, size]);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    const scope = path + '?' + appliedKey + '&size=' + size;
    const refreshing =
      previousRevision.current !== revision &&
      loadedScope.current === scope &&
      view === 'detail';
    const targetCount = refreshing ? (page?.items.length ?? 0) : 0;
    const viewport = refreshing
      ? document.querySelector<HTMLElement>('[aria-label="主內容"]')
      : null;
    pendingScroll.current = viewport
      ? { scope, top: viewport.scrollTop }
      : null;
    previousRevision.current = revision;
    // A filter change invalidates the old cursor before any request can use it.
    const params = {
      ...Object.fromEntries(new URLSearchParams(appliedKey)),
      ...(view === 'detail'
        ? { limit: size, ...(cursor ? { cursor } : {}) }
        : { group_by: group }),
    };
    void api<QueryPage | QuerySummary>(
      path + (view === 'summary' ? '/summary' : '') + '?' + queryParams(params),
    )
      .then(async (result) => {
        if (!live) return;
        if (view === 'detail') {
          let next = result as QueryPage;
          // Refresh the already-loaded prefix after editing without collapsing pagination or scroll context.
          while (
            live &&
            !cursor &&
            next.next_cursor &&
            next.items.length < targetCount
          ) {
            const following = await api<QueryPage>(
              path + '?' + queryParams({ ...params, cursor: next.next_cursor }),
            );
            next = {
              ...following,
              items: [
                ...new Map(
                  [...next.items, ...following.items].map((row) => [
                    row.id,
                    row,
                  ]),
                ).values(),
              ],
            };
          }
          if (!live) return;
          loadedScope.current = scope;
          setPage((old) =>
            cursor && old
              ? {
                  ...next,
                  items: [
                    ...new Map(
                      [...old.items, ...next.items].map((r) => [r.id, r]),
                    ).values(),
                  ],
                }
              : next,
          );
          setSummary(null);
        } else {
          setSummary(result as QuerySummary);
          setPage(null);
        }
      })
      .catch((e) => {
        if (live) {
          setError(errorMessage(e));
          setPage(null);
          setSummary(null);
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [path, appliedKey, view, group, cursor, size, retry, revision]);
  const profitScope = path + '?' + appliedKey;
  const [profitSummary, setProfitSummary] = useState<{
    key: string;
    value: QuerySummary;
  } | null>(null);
  const [profitError, setProfitError] = useState('');
  useEffect(() => {
    let live = true;
    setProfitSummary(null);
    setProfitError('');
    void api<QuerySummary>(
      path +
        '/summary?' +
        queryParams({
          ...Object.fromEntries(new URLSearchParams(appliedKey)),
          group_by: 'item',
        }),
    )
      .then((value) => {
        if (live) setProfitSummary({ key: profitScope, value });
      })
      .catch(() => {
        if (live) setProfitError('損益彙總暫時無法取得，請重新查詢。');
      });
    return () => {
      live = false;
    };
  }, [path, appliedKey, profitScope, retry, revision]);
  const profit =
    profitSummary?.key === profitScope
      ? queryProfit(profitSummary.value.items)
      : null;
  const datesKey = [
    ...new Set(page?.items.map((r) => r.occurred_on) ?? []),
  ].join(',');
  const dayScope =
    path + '?' + appliedKey + '&retry=' + retry + '&revision=' + revision;
  const [dayNets, setDayNets] = useState<{
    key: string;
    values: Record<string, string>;
  }>({ key: '', values: {} });
  const [dayError, setDayError] = useState('');
  useEffect(() => {
    if (!mobile || busy || view !== 'detail' || !datesKey) return;
    let live = true;
    const values = dayNets.key === dayScope ? { ...dayNets.values } : {};
    const missing = datesKey.split(',').filter((date) => !(date in values));
    if (!missing.length) return;
    setDayError('');
    void (async () => {
      // Existing owner-isolated query totals; max four simultaneous requests and a per-filter cache.
      for (let i = 0; i < missing.length; i += 4) {
        await Promise.all(
          missing.slice(i, i + 4).map(async (date) => {
            const p = await api<QuerySummary>(
              path +
                '/summary?' +
                queryParams({
                  ...Object.fromEntries(new URLSearchParams(appliedKey)),
                  date_from: date,
                  date_to: date,
                  group_by: 'item',
                }),
            );
            values[date] = applied.item_id
              ? (p.totals.selected_net_amount ?? '0')
              : queryProfit(p.items).net;
          }),
        );
        if (!live) return;
      }
      setDayNets({ key: dayScope, values });
    })().catch(() => {
      if (live) setDayError('當日淨額暫時無法取得，請重新查詢。');
    });
    return () => {
      live = false;
    };
  }, [path, appliedKey, datesKey, busy, mobile, view, retry, revision]);
  function apply() {
    setCursor(null);
    navigate(filtersUrl(clean));
    setAdvanced(false);
    setRetry((v) => v + 1);
  }
  function chooseView(value: string) {
    setView(value);
    setCursor(null);
  }
  function change(key: keyof typeof emptyFilters, value: string) {
    setDraft((old) => ({ ...old, [key]: value }));
  }
  const options = (values: { id: string; name: string; archived: boolean }[]) =>
    values.map((v) => ({
      value: v.id,
      label: v.name + (v.archived ? '（已封存）' : ''),
    }));
  const [exportReport, setExportReport] = useState<Life2023Export | null>(null);
  const [exporting, setExporting] = useState(false);
  async function downloadLife2023() {
    setExporting(true);
    setError('');
    setExportReport(null);
    try {
      const result = await api<Life2023Export>(
        path + '/life2023-export?' + queryParams(applied),
      );
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' }),
        url = URL.createObjectURL(blob),
        anchor = globalThis.document.createElement('a');
      anchor.href = url;
      anchor.download = 'life2023.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      notify('已匯出 CSV');
      setExportReport({ ...result, csv: '' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }
  async function download(format: 'detail' | 'entries') {
    setExporting(true);
    setError('');
    try {
      const response = await fetch(
        path + '/export.csv?' + queryParams({ ...applied, format }),
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(apiErrorMessage(body.error));
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `finmichi-${format}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  const totals = page?.totals ?? summary?.totals;
  const advancedFields = (
    <Stack>
      {mobile && (
        <>
          <TextInput
            label="起始日期"
            type="date"
            value={draft.date_from}
            onChange={(e) => change('date_from', e.currentTarget.value)}
          />
          <TextInput
            label="結束日期"
            type="date"
            value={draft.date_to}
            onChange={(e) => change('date_to', e.currentTarget.value)}
          />
          <ItemPicker
            items={items}
            mode="filter"
            label="篩選科目（含子科目）"
            searchable
            clearable
            data={options(items)}
            value={draft.item_id || null}
            onChange={(v) => change('item_id', v ?? '')}
          />
        </>
      )}
      <Select
        label="篩選收付人"
        searchable
        clearable
        data={options(payees)}
        value={draft.payee_id || null}
        onChange={(v) => change('payee_id', v ?? '')}
      />
      <TextInput
        label="最小交易金額（本位幣）"
        inputMode="decimal"
        value={draft.amount_min}
        onChange={(e) => change('amount_min', e.currentTarget.value)}
      />
      <TextInput
        label="最大交易金額（本位幣）"
        inputMode="decimal"
        value={draft.amount_max}
        onChange={(e) => change('amount_max', e.currentTarget.value)}
      />
      <Select
        label="交易類別"
        clearable
        data={Object.entries(kindNames).map(([value, label]) => ({
          value,
          label,
        }))}
        value={draft.kind || null}
        onChange={(v) => change('kind', v ?? '')}
      />
      {mobile && <Button onClick={apply}>套用進階篩選</Button>}
    </Stack>
  );
  const exportMenu = (
    <Menu withinPortal>
      <Menu.Target>
        <Button disabled={busy || dirty || exporting || !totals}>
          匯出 CSV
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => void download('detail')}>
          匯出明細 CSV
        </Menu.Item>
        <Menu.Item onClick={() => void download('entries')}>
          匯出分錄 CSV
        </Menu.Item>
        <Menu.Item onClick={() => void downloadLife2023()}>
          匯出 Life2023 CSV
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
  const appliedChips = (
    <>
      <div className="applied-chips">
        {Object.entries(applied).map(([k, v]) => (
          <button
            key={k}
            className="filter-chip"
            aria-label={'移除條件 ' + k}
            onClick={() => {
              const next = { ...applied };
              delete next[k];
              setCursor(null);
              navigate(filtersUrl(next));
            }}
          >
            {
              (
                {
                  date_from: '起',
                  date_to: '迄',
                  keyword: '搜尋',
                  item_id: '科目',
                  kind: '類別',
                  project_id: '專案',
                  payee_id: '收付人',
                  amount_min: '最小',
                  amount_max: '最大',
                } as Record<string, string>
              )[k]
            }
            ：
            {items.find((i) => i.id === v)?.name ??
              payees.find((i) => i.id === v)?.name ??
              projects.find((i) => i.id === v)?.name ??
              kindNames[v as keyof typeof kindNames] ??
              v}{' '}
            ×
          </button>
        ))}
      </div>
    </>
  );
  const viewControls = (
    <>
      <Group justify="space-between">
        <SegmentedControl
          aria-label="查詢檢視"
          value={view}
          onChange={chooseView}
          data={[
            { value: 'detail', label: '明細' },
            { value: 'summary', label: '彙總' },
          ]}
        />
        {view === 'detail' && (
          <Select
            label="每次載入筆數"
            value={size}
            onChange={(v) => {
              if (v) {
                setSize(v);
                setCursor(null);
              }
            }}
            data={['1', '10', '25', '50', '100']}
          />
        )}
      </Group>
      {view === 'summary' && (
        <Group>
          <Select
            label="彙總方式"
            value={group}
            onChange={(v) => {
              if (v) setGroup(v);
            }}
            data={[
              { value: 'item', label: '依科目' },
              { value: 'month', label: '依月份與類別' },
              { value: 'project', label: projectReportText.group },
            ]}
          />
          {group === 'item' && (
            <Checkbox
              label="使用自然方向顯示"
              checked={natural}
              onChange={(e) => setNatural(e.currentTarget.checked)}
            />
          )}
        </Group>
      )}
    </>
  );
  return (
    <Stack className="transaction-query" aria-busy={busy}>
      <div className="page-heading">
        <div>
          <h2>明細</h2>
          <div className="query-totals" role="status">
            {totals ? (
              <>
                <span className="query-count">共 {totals.count} 筆</span>{' '}
                {applied.item_id ? (
                  <>
                    科目淨變動{' '}
                    <span className="num">
                      {formatMoney(
                        profitSummary?.key === profitScope
                          ? profitSummary.value.totals.selected_net_amount
                          : null,
                        ledger.base_currency,
                      )}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="query-profit-part">
                      收入{' '}
                      <span className="num kind-text-income">
                        {formatMoney(
                          profit?.income ?? null,
                          ledger.base_currency,
                        )}
                      </span>
                    </span>{' '}
                    <span className="query-profit-part">
                      支出{' '}
                      <span className="num kind-text-expense">
                        {formatMoney(
                          profit ? negate(profit.expense) : null,
                          ledger.base_currency,
                        )}
                      </span>
                    </span>
                  </>
                )}
              </>
            ) : busy ? (
              '載入查詢…'
            ) : (
              '尚未取得查詢結果'
            )}
          </div>
        </div>
        <Group gap="xs">
          {!mobile && exportMenu}
          {mobile && (
            <Button
              variant="subtle"
              aria-expanded={advanced}
              onClick={() => setAdvanced(true)}
            >
              篩選與工具（{Object.keys(applied).length}）
            </Button>
          )}
          <Button className="desktop-action" onClick={() => openEntry()}>
            ＋ 記一筆
          </Button>
        </Group>
      </div>
      {profitError && <Alert role="alert">{profitError}</Alert>}
      {error && (
        <Alert role="alert" color="red">
          {error}
          <Button
            variant="subtle"
            onClick={() => {
              setCursor(null);
              setRetry((v) => v + 1);
            }}
          >
            重新查詢
          </Button>
        </Alert>
      )}
      <section className="panel filter-panel">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="filter-grid">
            <TextInput
              ref={applyQuerySearchFocus}
              data-query-search
              label="關鍵字"
              placeholder="搜尋摘要、發票號碼"
              value={draft.keyword}
              onChange={(e) => change('keyword', e.currentTarget.value)}
              onKeyDown={(e) => {
                // A second common filter disables native implicit form submission on mobile.
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  apply();
                }
              }}
              maxLength={200}
            />
            {!mobile && (
              <>
                <TextInput
                  label="起始日期"
                  type="date"
                  value={draft.date_from}
                  onChange={(e) => change('date_from', e.currentTarget.value)}
                />
                <TextInput
                  label="結束日期"
                  type="date"
                  value={draft.date_to}
                  onChange={(e) => change('date_to', e.currentTarget.value)}
                />
                <ItemPicker
                  items={items}
                  mode="filter"
                  label="篩選科目（含子科目）"
                  searchable
                  clearable
                  data={options(items)}
                  value={draft.item_id || null}
                  onChange={(v) => change('item_id', v ?? '')}
                />
              </>
            )}
            <Select
              label={mobile ? undefined : '篩選專案'}
              aria-label="篩選專案"
              placeholder="篩選專案"
              size={mobile ? 'xs' : 'sm'}
              searchable
              clearable
              data={options(projects)}
              value={draft.project_id || null}
              onChange={(v) => change('project_id', v ?? '')}
            />
          </div>
          <EdgeScroll axis="x" label="交易類別篩選">
            <div className="filter-kinds">
              {[['', '全部'], ...Object.entries(kindNames)].map(
                ([kind, label]) => (
                  <button
                    type="button"
                    key={kind}
                    className="filter-chip"
                    aria-pressed={draft.kind === kind}
                    onClick={() => {
                      change('kind', kind!);
                      if (mobile) {
                        setCursor(null);
                        navigate(filtersUrl({ ...clean, kind: kind! }));
                      }
                    }}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </EdgeScroll>
          {!mobile && (
            <Group>
              <Button type="submit" disabled={busy}>
                套用篩選
              </Button>
              <Button
                type="button"
                variant="subtle"
                aria-expanded={advanced}
                onClick={() => setAdvanced((v) => !v)}
              >
                進階篩選
              </Button>
              <Button
                type="button"
                variant="subtle"
                onClick={() => {
                  setCursor(null);
                  navigate('/transactions');
                  setDraft(emptyFilters);
                  setRetry((v) => v + 1);
                }}
              >
                清除篩選
              </Button>
            </Group>
          )}
          {!mobile && advanced && (
            <div className="advanced-filters">{advancedFields}</div>
          )}
        </form>
      </section>
      {mobile && (
        <Drawer
          opened={advanced}
          onClose={() => setAdvanced(false)}
          position="bottom"
          size="auto"
          title="篩選與工具"
          classNames={{ body: 'filter-drawer-body' }}
          closeButtonProps={{ 'aria-label': '關閉篩選與工具' }}
        >
          <EdgeScroll label="進階篩選內容" className="filter-drawer-scroll">
            <Stack>
              {advancedFields}
              {dirty && <Text c="orange">條件已變更，請套用篩選。</Text>}
              {appliedChips}
              <Button
                variant="subtle"
                onClick={() => {
                  setCursor(null);
                  setDraft(emptyFilters);
                  navigate('/transactions');
                }}
              >
                清除篩選
              </Button>
              {viewControls}
              <Select
                label="已載入交易排序"
                value={sort}
                onChange={(v) => {
                  if (v) setSort(v as typeof sort);
                }}
                data={[
                  { value: 'date-desc', label: '日期由新到舊' },
                  { value: 'date-asc', label: '日期由舊到新' },
                  { value: 'amount-desc', label: '交易金額由大到小' },
                ]}
              />
              <Text size="sm">排序僅套用已載入資料；載入更多後一併排序。</Text>
              {exportMenu}
            </Stack>
          </EdgeScroll>
        </Drawer>
      )}
      {!mobile && dirty && <Text c="orange">條件已變更，請套用篩選。</Text>}
      {!mobile && appliedChips}
      {exportReport && (
        <Alert role="status">
          已匯出 {exportReport.exported_count} 筆；未匯出{' '}
          {exportReport.skipped_count} 筆。
          {exportReport.skip_reasons.map((r) => (
            <Text key={r.code}>
              {r.code === 'multiple_entries' ? '多筆分錄' : '含外幣科目'}：
              {r.count} 筆
            </Text>
          ))}
          {exportReport.skipped_count > 0 && (
            <Text>請改用「匯出分錄 CSV」保留完整分錄。</Text>
          )}
        </Alert>
      )}
      {!mobile && viewControls}
      {busy && (
        <LoadingState
          label="查詢中"
          hasData={page !== null || summary !== null}
        />
      )}
      {dayError && <Text c="orange">{dayError}</Text>}
      {view === 'detail' && page && (
        <>
          <TransactionList
            rows={page.items}
            currency={ledger.base_currency}
            sortable
            sort={sort}
            onSortChange={setSort}
            dayNetLabel={applied.item_id ? '科目淨變動' : '日淨額'}
            dayNets={dayNets.key === dayScope ? dayNets.values : {}}
          />
          {!page.items.length && (
            <EmptyState title="沒有符合條件的交易">
              試著調整篩選條件，或按「＋ 記一筆」開始。
            </EmptyState>
          )}
          <Group justify="center">
            <Text>
              已載入 {page.items.length}／{page.totals.count} 筆
            </Text>
            <Button
              disabled={busy || !page.next_cursor}
              onClick={() => setCursor(page.next_cursor)}
            >
              載入更多
            </Button>
          </Group>
        </>
      )}
      {summary?.group_by === 'project' && (
        <Text size="sm" c="dimmed">
          {projectReportText.groupHelp}
        </Text>
      )}
      {summary?.group_by === 'project' &&
        summary.projects?.map((row) => (
          <Paper key={row.id} withBorder p="md">
            <Text fw={600}>{row.name}</Text>
            <Text>
              {row.count} 筆，交易金額{' '}
              {formatMoney(row.transaction_amount, ledger.base_currency)}
            </Text>
            {row.selected_net_amount !== null && (
              <Text>
                所選科目淨變動{' '}
                {formatMoney(row.selected_net_amount, ledger.base_currency)}
              </Text>
            )}
          </Paper>
        ))}
      {summary &&
        summary.group_by === 'item' &&
        tree(summary.items).map(({ row, depth }) => (
          <Paper key={row.id} withBorder p="sm" ml={Math.min(depth, 4) * 12}>
            <Stack gap={4}>
              <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
                {row.name}
              </Text>
              <Text>
                {natural ? '自然方向' : '借貸符號'}：
                {formatMoney(
                  natural ? row.natural_amount : row.signed_amount,
                  ledger.base_currency,
                )}
              </Text>
              <Text>
                含子科目小計：
                {formatMoney(
                  natural
                    ? row.rollup_natural_amount
                    : row.rollup_signed_amount,
                  ledger.base_currency,
                )}
              </Text>
            </Stack>
          </Paper>
        ))}
      {summary &&
        summary.group_by === 'month' &&
        [...new Set(summary.months.map((m) => m.month))].map((month) => (
          <Paper key={month} withBorder p="md">
            <Stack>
              <Title order={3}>{month}</Title>
              {summary.months
                .filter((m) => m.month === month)
                .map((m) => (
                  <Text key={m.kind}>
                    {kindNames[m.kind]}：{m.count} 筆，交易金額{' '}
                    {formatMoney(m.transaction_amount, ledger.base_currency)}
                  </Text>
                ))}
              {summary.monthly_net.find((m) => m.month === month) && (
                <Text>
                  本月所選科目淨額：
                  {formatMoney(
                    summary.monthly_net.find((m) => m.month === month)!
                      .selected_net_amount,
                    ledger.base_currency,
                  )}
                </Text>
              )}
            </Stack>
          </Paper>
        ))}
      {!busy && view === 'summary' && summary && summary.totals.count === 0 && (
        <EmptyState title="沒有符合條件的彙總">
          調整日期或其他篩選條件。
        </EmptyState>
      )}
      <BackToTop />
    </Stack>
  );
}
