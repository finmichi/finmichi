// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Switch } from '@mantine/core';
import type { BalanceReport } from '@finmichi/core/report-schemas';
import { ReportTree } from '../report-common';
import { formatMoney } from './format';
import {
  accountTree,
  readAccountState,
  writeAccountState,
} from './overview-accounts-model';
export function OverviewAccounts({
  ledger,
  currency,
  report,
}: {
  ledger: string;
  currency: string;
  report: BalanceReport;
}) {
  const [state, setState] = useState(() => readAccountState(ledger));
  const update = (expanded: Set<string>, showZero: boolean) => {
    setState({ expanded, showZero });
    writeAccountState(ledger, expanded, showZero);
  };
  return (
    <div className="panel-body overview-account-tree" aria-label="帳戶餘額分類">
      <Switch
        label="顯示 0 餘額"
        checked={state.showZero}
        onChange={(event) =>
          update(state.expanded, event.currentTarget.checked)
        }
      />
      <p className="subtle">
        本位幣顯示帳面值，與同日資產負債表一致；外幣另列自身原幣餘額。
      </p>
      <ReportTree
        rows={accountTree(report, state.showZero)}
        expanded={state.expanded}
        onExpandedChange={(expanded) => update(expanded, state.showZero)}
        columns={[
          {
            label: '原幣餘額',
            render: (row) =>
              row.original === null ? (
                '—'
              ) : (
                <span className="report-money">
                  {formatMoney(row.original, row.currency)}
                </span>
              ),
          },
          {
            label: '帳面值',
            render: (row) => (
              <span className="report-money">
                {formatMoney(row.book, currency)}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
