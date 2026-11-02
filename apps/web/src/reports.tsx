// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, lazy, Suspense } from 'react';
import { LoadingState } from './design/feedback';
const ProjectAnalysis = lazy(() =>
  import('./project-report').then((m) => ({ default: m.ProjectAnalysis })),
);
const ProfitLoss = lazy(() =>
  import('./extended-reports').then((m) => ({ default: m.ProfitLoss })),
);
const FlowReports = lazy(() =>
  import('./extended-reports').then((m) => ({ default: m.FlowReports })),
);
import { BudgetVsActual } from './budget-report';
import { EdgeScroll } from './design/edge-scroll';
import { useLocation, navigate } from './design/location';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { BalanceSheet } from './balance-report';
import { IncomeSummary } from './income-report';
import { CategoryStatistics } from './category-report';
const reports = [
  ['balance-sheet', '資產負債表'],
  ['income-summary', '收支彙總'],
  ['category-statistics', '分類統計'],
  ['budget-vs-actual', '預算 vs 實際'],
  ['profit-loss', '損益表'],
  ['flow', '流量'],
  ['projects', '專案分析'],
] as const;
export function Reports({ ledger }: { ledger: Ledger }) {
  const route = useLocation().split('?')[0]!.split('/').at(-1)!;
  const kind = reports.some(([id]) => id === route) ? route : 'balance-sheet';
  const nav = useRef<HTMLElement>(null);
  // Keep the effect return void: supported browsers can return a Promise here.
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [kind]);
  return (
    <div className="report-workspace">
      <EdgeScroll axis="x" label="報表導覽">
        <nav ref={nav} className="report-nav" aria-label="報表分頁">
          {reports.map(([id, label]) => (
            <a
              key={id}
              href={'/reports/' + id}
              aria-current={kind === id ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate('/reports/' + id);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
      </EdgeScroll>
      {kind === 'projects' ? (
        <Suspense fallback={<LoadingState />}>
          <ProjectAnalysis key={ledger.id} ledger={ledger} />
        </Suspense>
      ) : kind === 'profit-loss' || kind === 'flow' ? (
        <Suspense fallback={<LoadingState label="報表載入中" />}>
          {kind === 'profit-loss' ? (
            <ProfitLoss key={ledger.id} ledger={ledger} />
          ) : (
            <FlowReports ledger={ledger} />
          )}
        </Suspense>
      ) : kind === 'budget-vs-actual' ? (
        <BudgetVsActual ledger={ledger} />
      ) : kind === 'balance-sheet' ? (
        <BalanceSheet ledger={ledger} />
      ) : kind === 'income-summary' ? (
        <IncomeSummary ledger={ledger} />
      ) : (
        <CategoryStatistics ledger={ledger} />
      )}
    </div>
  );
}
