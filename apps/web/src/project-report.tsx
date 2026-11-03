// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, lazy, Suspense, useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Group,
  Stack,
  TextInput,
  Title,
  Text,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type {
  ProjectReport,
  ProjectReportRow,
} from '@finmichi/core/report-schemas';
import { useLocation, navigate } from './design/location';
import {
  projectAnalysisUrl,
  projectFiltersFromLocation,
  projectFiltersUrl,
} from './design/report-state';
import { filtersUrl } from './design/query-state';
import { formatMoney } from './design/format';
import { EdgeScroll } from './design/edge-scroll';
import { LoadingState, ErrorState, EmptyState } from './design/feedback';
import { useReport } from './report-hooks';
import { ReportTree, todayTaipei } from './report-common';
import { projectReportText as t } from './project-report-messages';
const ProjectCharts = lazy(() => import('./project-charts'));
export function ProjectAnalysis({ ledger }: { ledger: Ledger }) {
  const location = useLocation();
  const [bounds, setBounds] = useState<{
    ledger: string;
    project: string;
    first_on: string | null;
    last_on: string | null;
  } | null>(null);
  const initial = projectFiltersFromLocation(location, todayTaipei());
  const applied = projectFiltersFromLocation(
    location,
    todayTaipei(),
    bounds?.ledger === ledger.id && bounds.project === initial.project
      ? bounds
      : undefined,
  );
  const [draft, setDraft] = useState(applied);
  useEffect(
    () => setDraft(applied),
    [location, applied.date_from, applied.date_to],
  );
  const { project, ...apiFilters } = applied;
  const result = useReport<ProjectReport>(
    `/api/ledgers/${ledger.id}/reports/projects?${new URLSearchParams(apiFilters)}`,
  );
  useEffect(() => {
    if (!result.data || result.data.ledger_id !== ledger.id) return;
    const row = result.data.projects.find((p) => p.id === project);
    setBounds({
      ledger: ledger.id,
      project,
      first_on: row?.available_first_on ?? null,
      last_on: row?.available_last_on ?? null,
    });
  }, [result.data, ledger.id, project]);
  const mobile = useMediaQuery('(max-width:899px)');
  const money = (v: string | null) => formatMoney(v, ledger.base_currency);
  const selected = result.data?.projects.find((p) => p.id === project);
  const actions = (row: ProjectReportRow) => (
    <Group gap="xs">
      <Button
        size="compact-sm"
        aria-label={`${t.analysis} ${row.name}`}
        onClick={() => navigate(projectAnalysisUrl(location, row.id))}
      >
        {t.analysis}
      </Button>
      <Button
        size="compact-sm"
        variant="subtle"
        onClick={() =>
          navigate(
            filtersUrl({
              date_from: applied.date_from,
              date_to: applied.date_to,
              project_id: row.id,
            }),
          )
        }
        aria-label={`${t.transactions} ${row.name}`}
      >
        {t.transactions}
      </Button>
    </Group>
  );
  const tree = (row: ProjectReportRow) => (
    <details aria-label={`${t.tree} ${row.name}`}>
      <summary>{t.tree}</summary>
      <ReportTree
        key={row.id}
        rows={row.items}
        columns={[
          {
            label: t.income,
            render: (i) => (i.kind === 'income' ? money(i.rollup_amount) : '—'),
          },
          {
            label: t.expense,
            render: (i) =>
              i.kind === 'expense' ? money(i.rollup_amount) : '—',
          },
        ]}
      />
    </details>
  );
  return (
    <Stack className="report-page" style={{ minWidth: 0 }}>
      <Title order={2}>{t.title}</Title>
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(projectFiltersUrl(draft));
          result.retry();
        }}
      >
        <div className="report-toolbar">
          <TextInput
            type="date"
            label={t.from}
            value={draft.date_from}
            onChange={(e) =>
              setDraft({ ...draft, date_from: e.currentTarget.value })
            }
          />
          <TextInput
            type="date"
            label={t.to}
            value={draft.date_to}
            onChange={(e) =>
              setDraft({ ...draft, date_to: e.currentTarget.value })
            }
          />
          <Checkbox
            label={t.archived}
            checked={draft.include_archived === 'true'}
            onChange={(e) =>
              setDraft({
                ...draft,
                include_archived: e.currentTarget.checked ? 'true' : 'false',
              })
            }
          />
          <Button type="submit">{t.generate}</Button>
          <Button
            variant="subtle"
            disabled={!result.data}
            onClick={() =>
              navigate(
                projectFiltersUrl({
                  ...applied,
                  date_from: result.data?.first_transaction_on ?? todayTaipei(),
                  date_to: todayTaipei(),
                }),
              )
            }
          >
            {t.allPeriods}
          </Button>
        </div>
      </form>
      <details>
        <summary>{t.expand}</summary>
        <Text>{t.explanation}</Text>
      </details>
      {result.error && (
        <ErrorState message={result.error} retry={result.retry} />
      )}
      {result.busy && <LoadingState label={t.loading} />}
      {result.data && !result.data.projects.length && (
        <EmptyState title={t.empty}>{t.emptyHelp}</EmptyState>
      )}
      {result.data &&
        (mobile ? (
          <div className="report-cards">
            {result.data.projects.map((row) => (
              <article key={row.id} className="report-card">
                <Title order={3}>
                  <a
                    href={filtersUrl({
                      date_from: applied.date_from,
                      date_to: applied.date_to,
                      project_id: row.id,
                    })}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(e.currentTarget.getAttribute('href')!);
                    }}
                  >
                    {row.name}
                  </a>
                  {row.archived ? t.archivedSuffix : ''}
                </Title>
                <dl>
                  {[
                    [t.income, money(row.income)],
                    [t.expense, money(row.expense)],
                    [t.net, money(row.net)],
                    [t.count, row.transaction_count],
                    [
                      t.dates,
                      `${row.first_on ?? '—'} ～ ${row.last_on ?? '—'}`,
                    ],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
                {actions(row)}
                {tree(row)}
              </article>
            ))}
          </div>
        ) : (
          <EdgeScroll axis="x" label={t.title}>
            <table className="report-table">
              <thead>
                <tr>
                  {[
                    t.project,
                    t.income,
                    t.expense,
                    t.net,
                    t.count,
                    t.dates,
                    t.analysis,
                  ].map((l) => (
                    <th key={l} scope="col">
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.data.projects.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <th scope="row">
                        <a
                          href={filtersUrl({
                            date_from: applied.date_from,
                            date_to: applied.date_to,
                            project_id: row.id,
                          })}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(e.currentTarget.getAttribute('href')!);
                          }}
                        >
                          {row.name}
                        </a>
                        {row.archived ? t.archivedSuffix : ''}
                      </th>
                      <td className="num">{money(row.income)}</td>
                      <td className="num">{money(row.expense)}</td>
                      <td className="num">{money(row.net)}</td>
                      <td>{row.transaction_count}</td>
                      <td>
                        {row.first_on ?? '—'}
                        <br />
                        {row.last_on ?? '—'}
                      </td>
                      <td>{actions(row)}</td>
                    </tr>
                    <tr>
                      <td colSpan={7}>{tree(row)}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </EdgeScroll>
        ))}
      {selected ? (
        <section
          className="panel"
          aria-label={`${t.analysis} ${selected.name}`}
        >
          <Stack>
            <Title order={3}>
              {t.title}：{selected.name}
            </Title>
            <dl className="income-values">
              <div>
                <dt>{t.average}</dt>
                <dd className="num">{money(selected.daily_average_expense)}</dd>
              </div>
              <div>
                <dt>{t.days}</dt>
                <dd>{selected.days}</dd>
              </div>
            </dl>
            <Title order={4}>{t.currencies}</Title>
            <div className="report-cards">
              {selected.currencies.map((c) => (
                <article key={c.currency} className="report-card">
                  <strong>{c.currency}</strong>
                  <dl>
                    <div>
                      <dt>{t.original}</dt>
                      <dd className="num">
                        {formatMoney(c.original_expense, c.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.base}</dt>
                      <dd className="num">{money(c.base_expense)}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
            <Title order={4}>{t.composition}</Title>
            <Suspense fallback={<LoadingState />}>
              <ProjectCharts row={selected} currency={ledger.base_currency} />
            </Suspense>
            <ReportTree
              key={selected.id}
              rows={selected.items.filter((i) => i.kind === 'expense')}
              columns={[
                { label: t.expense, render: (i) => money(i.rollup_amount) },
              ]}
            />
            {applied.date_from.slice(0, 7) !== applied.date_to.slice(0, 7) && (
              <>
                <Title order={4}>{t.trend}</Title>
                <Suspense fallback={<LoadingState />}>
                  <ProjectCharts
                    row={selected}
                    currency={ledger.base_currency}
                    trend
                  />
                </Suspense>
                <div className="report-cards">
                  {selected.months.map((m) => (
                    <article key={m.month} className="report-card">
                      <strong>{m.month}</strong>
                      <dl>
                        <div>
                          <dt>{t.income}</dt>
                          <dd>{money(m.income)}</dd>
                        </div>
                        <div>
                          <dt>{t.expense}</dt>
                          <dd>{money(m.expense)}</dd>
                        </div>
                        <div>
                          <dt>{t.net}</dt>
                          <dd>{money(m.net)}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </>
            )}
          </Stack>
        </section>
      ) : (
        result.data && <Text>{t.select}</Text>
      )}
    </Stack>
  );
}
