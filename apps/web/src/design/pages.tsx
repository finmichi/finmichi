// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense } from 'react';
import { Button } from '@mantine/core';
import { useLocation, navigate } from './location';
import { isKnownRoute } from './routes';
import { useWorkspace } from './workspace';
import {
  EmptyState,
  LoadingState,
  ErrorState,
  Toast,
  notify,
  PageBoundary,
} from './feedback';
const Investments = lazy(() =>
  import('../investments').then((m) => ({ default: m.Investments })),
);
const Overview = lazy(() =>
  import('./overview').then((m) => ({ default: m.Overview })),
);
const TransactionQuery = lazy(() =>
  import('../query').then((m) => ({ default: m.TransactionQuery })),
);
const Reports = lazy(() =>
  import('../reports').then((m) => ({ default: m.Reports })),
);
const Admin = lazy(() => import('./admin').then((m) => ({ default: m.Admin })));
const EntryOverlay = lazy(() =>
  import('./entry-overlay').then((m) => ({ default: m.EntryOverlay })),
);
function PageContent(props: { subject: string; onLogout: () => void }) {
  const location = useLocation(),
    path = location.split('?')[0]!;
  const { current, error, loading, refresh } = useWorkspace();
  if (!isKnownRoute(path))
    return (
      <EmptyState
        title="找不到頁面"
        headingLevel={2}
        action={
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
          >
            回總覽
          </a>
        }
      />
    );
  if (loading) return <LoadingState label="載入帳本" />;
  if (error)
    return (
      <ErrorState
        message={error}
        retry={() => void refresh().catch(() => {})}
      />
    );
  if (path.startsWith('/admin')) return <Admin {...props} />;
  if (!current)
    return (
      <EmptyState
        title="先建立一本帳本"
        action={
          <Button onClick={() => navigate('/admin/ledgers')}>新增帳本</Button>
        }
      >
        到管理中心新增帳本，再開始記帳或匯入資料。
      </EmptyState>
    );
  if (path.startsWith('/investments'))
    return <Investments key={current.id} ledger={current} />;
  if (path.startsWith('/reports'))
    return <Reports key={current.id} ledger={current} />;
  return path === '/' ? (
    <Overview key={current.id} ledger={current} />
  ) : (
    <TransactionQuery key={current.id} ledger={current} />
  );
}
export function WorkspacePages(props: {
  subject: string;
  onLogout: () => void;
}) {
  const location = useLocation(),
    { current } = useWorkspace();
  const entry = new URLSearchParams(location.split('?')[1] ?? '').get('entry');
  return (
    <>
      <PageBoundary key={location.split('?')[0]}>
        <Suspense fallback={<LoadingState label="載入頁面" />}>
          <PageContent {...props} />
        </Suspense>
      </PageBoundary>
      {entry && current && (
        <PageBoundary key={'entry:' + entry}>
          <Suspense fallback={<LoadingState label="載入記帳" />}>
            <EntryOverlay
              key={current.id + ':' + entry}
              ledger={current}
              entry={entry}
              onSaved={(message) => {
                notify(message);
                window.dispatchEvent(new Event('ledger:transactions-changed'));
              }}
            />
          </Suspense>
        </PageBoundary>
      )}
      <Toast />
    </>
  );
}
