// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense, useEffect, useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { Button } from '@mantine/core';
import { adminRoutes, routeTitle } from './routes';
import { navigate, useLocation } from './location';
import { useWorkspace } from './workspace';
import { EdgeScroll } from './edge-scroll';
import { EmptyState, LoadingState } from './feedback';
import { api } from '../api';
const InvestmentSettings = lazy(() =>
  import('../investment-settings').then((m) => ({
    default: m.InvestmentSettings,
  })),
);
const ReminderSettingsPage = lazy(() =>
  import('../reminders').then((m) => ({ default: m.ReminderSettingsPage })),
);
const MarketRates = lazy(() =>
  import('../market-rates').then((m) => ({ default: m.MarketRates })),
);
const Drafts = lazy(() =>
  import('../drafts').then((m) => ({ default: m.Drafts })),
);
const Finance = lazy(() =>
  import('../finance').then((m) => ({ default: m.Finance })),
);
const Budgets = lazy(() =>
  import('../budgets').then((m) => ({ default: m.Budgets })),
);
const Recurring = lazy(() =>
  import('../recurring').then((m) => ({ default: m.Recurring })),
);
const Ledgers = lazy(() =>
  import('../ledgers').then((m) => ({ default: m.Ledgers })),
);
const Items = lazy(() =>
  import('../items').then((m) => ({ default: m.Items })),
);
const NamedRecords = lazy(() =>
  import('../named-records').then((m) => ({ default: m.NamedRecords })),
);
const Import = lazy(() =>
  import('./import-page').then((m) => ({ default: m.ImportPage })),
);
const Backup = lazy(() =>
  import('./backup-page').then((m) => ({ default: m.BackupPage })),
);
const Pats = lazy(() => import('../pats').then((m) => ({ default: m.Pats })));
const Audit = lazy(() =>
  import('../audit-log').then((m) => ({ default: m.AuditLog })),
);
const System = lazy(() =>
  import('./system-page').then((m) => ({ default: m.SystemPage })),
);
const groups = [
  ['帳務設定', [0, 1, 2, 3, 4, 10, 11, 12, 13, 15, 16, 17]],
  ['資料', [5, 6]],
  ['安全與整合', [7, 8, 9, 14]],
] as const;
export function Admin(props: { subject: string; onLogout: () => void }) {
  const path = useLocation().split('?')[0]!;
  const desktop = useMediaQuery('(min-width: 900px)');
  const { ledgers, current, refresh } = useWorkspace();
  const [counts, setCounts] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    async function load() {
      const resources = ['items', 'payees', 'projects', 'memo_templates'];
      const rows = current
        ? await Promise.allSettled(
            resources.map((r) =>
              api<unknown[]>(
                `/api/ledgers/${current.id}/${r}?include_archived=true`,
              ),
            ),
          )
        : [];
      const extras = await Promise.allSettled([
        api<unknown[]>('/api/pats'),
        api<{ items: unknown[]; next_cursor: string | null }>(
          '/api/audit-logs?limit=25',
        ),
        api<{ items: unknown[]; next_cursor: string | null }>(
          '/api/audit-logs?limit=25&action=emoney.import',
        ),
      ]);
      const recurring = current
        ? await api<{ pending_count: number }>(
            `/api/ledgers/${current.id}/recurring`,
          ).catch(() => null)
        : null;
      const drafts = current
        ? await api<{ pending_count: number }>(
            `/api/ledgers/${current.id}/drafts?status=pending&limit=1`,
          ).catch(() => null)
        : null;
      if (live) {
        const next: Record<string, string> = Object.fromEntries(
          resources.map((r, i) => [
            '/admin/' + r.replace('_', '-'),
            rows[i]?.status === 'fulfilled'
              ? String(
                  (rows[i] as PromiseFulfilledResult<unknown[]>).value.length,
                )
              : '—',
          ]),
        );
        next['/admin/drafts'] = drafts ? String(drafts.pending_count) : '—';
        next['/admin/recurring'] = recurring
          ? String(recurring.pending_count)
          : '—';
        next['/admin/tokens'] =
          extras[0]?.status === 'fulfilled'
            ? String(extras[0].value.length)
            : '—';
        for (const [key, i] of [
          ['/admin/audit', 1],
          ['/admin/import', 2],
        ] as const) {
          const result = extras[i];
          next[key] =
            result?.status === 'fulfilled'
              ? String(result.value.items.length) +
                (result.value.next_cursor ? '+' : '')
              : '—';
        }
        setCounts(next);
      }
    }
    void load();
    window.addEventListener('ledger:catalogs-changed', load);
    return () => {
      live = false;
      window.removeEventListener('ledger:catalogs-changed', load);
    };
  }, [current?.id]);
  const menu = (
    <nav aria-label="管理項目" className="admin-navigation">
      {groups.map(([label, indices]) => (
        <section key={label}>
          <h2>{label}</h2>
          {indices.map((i) => {
            const [href, name] = adminRoutes[i];
            const count =
              href === '/admin/ledgers' ? String(ledgers.length) : counts[href];
            return (
              <a
                key={href}
                href={href}
                aria-current={path === href ? 'page' : undefined}
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    navigate(href);
                  }
                }}
              >
                <span>{name}</span>
                {count !== undefined ? (
                  <span
                    className="admin-count"
                    title="科目與名稱清單含封存；紀錄以已載入筆數加＋表示尚有更多"
                  >
                    {count}
                  </span>
                ) : (
                  <span aria-hidden="true">›</span>
                )}
              </a>
            );
          })}
        </section>
      ))}
    </nav>
  );
  function content() {
    if (path === '/admin/ledgers') return <Ledgers />;
    if (path === '/admin/tokens') return <Pats />;
    if (path === '/admin/audit') return <Audit />;
    if (path === '/admin/system') return <System {...props} />;
    if (!current)
      return (
        <EmptyState
          title="先建立一本帳本"
          action={
            <Button onClick={() => navigate('/admin/ledgers')}>新增帳本</Button>
          }
        >
          管理科目或匯入資料前，請先建立帳本。
        </EmptyState>
      );
    if (path === '/admin/cards' || path === '/admin/loans')
      return (
        <Finance
          key={current.id + path}
          ledger={current}
          type={path === '/admin/cards' ? 'cards' : 'loans'}
        />
      );
    if (path === '/admin/reminders')
      return <ReminderSettingsPage key={current.id} ledger={current.id} />;
    if (path === '/admin/investment-settings')
      return <InvestmentSettings key={current.id} ledger={current} />;
    if (path === '/admin/exchange-rates')
      return <MarketRates key={current.id} ledger={current} />;
    if (path === '/admin/drafts')
      return <Drafts key={current.id} ledger={current} />;
    if (path === '/admin/budgets')
      return <Budgets key={current.id} ledger={current} />;
    if (path === '/admin/recurring')
      return <Recurring key={current.id} ledger={current} />;
    if (path === '/admin/items' || path === '/admin')
      return <Items key={current.id} ledger={current} />;
    if (path === '/admin/import')
      return <Import key={current.id} ledger={current} />;
    if (path === '/admin/backup')
      return (
        <Backup key={current.id} ledger={current} onLedgerChange={refresh} />
      );
    const resource =
      path === '/admin/payees'
        ? 'payees'
        : path === '/admin/projects'
          ? 'projects'
          : 'memo_templates';
    return (
      <NamedRecords
        key={current.id + resource}
        ledger={current}
        resource={resource}
        label={routeTitle(path)}
      />
    );
  }
  return (
    <div className="admin-workspace">
      {desktop ? (
        <aside className="admin-sidebar">
          <EdgeScroll label="管理中心導覽">{menu}</EdgeScroll>
        </aside>
      ) : path === '/admin' ? (
        menu
      ) : null}
      {(desktop || path !== '/admin') && (
        <section
          className={
            'admin-content' +
            (path === '/admin/cards' || path === '/admin/loans'
              ? ' finance-workspace'
              : '')
          }
          aria-label="管理內容"
        >
          <Suspense fallback={<LoadingState label="載入管理頁" />}>
            {content()}
          </Suspense>
        </section>
      )}
    </div>
  );
}
