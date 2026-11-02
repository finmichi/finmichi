// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button, Checkbox, Group, Stack, Text, TextInput } from '@mantine/core';
import type { Ledger, Item } from '@finmichi/core/catalog-schemas';
import { api, errorMessage } from './api';
import {
  DividendEntry,
  type DividendRecord,
  type DividendCode,
} from './dividend-entry';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ConfirmDialog,
  notify,
} from './design/feedback';
import { formatMoney } from './design/format';
import { navigate, useLocation } from './design/location';
interface Report {
  items: DividendRecord[];
  codes: { code: string; amount: string; taxable_amount: string }[];
  totals: {
    count: number;
    gross_amount: string;
    net_amount: string;
    withholding_tax: string;
    nhi_premium: string;
    fee: string;
  };
}
export function Dividends({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    query = new URL(location, 'https://local.invalid').searchParams,
    today = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Taipei',
    }).format(new Date()),
    from = query.get('date_from') ?? today.slice(0, 7) + '-01',
    to = query.get('date_to') ?? today,
    selected = query.get('security_id') ?? undefined,
    base = `/api/ledgers/${ledger.id}`,
    linkedId = query.get('dividend_id');
  const [dateFrom, setFrom] = useState(from),
    [dateTo, setTo] = useState(to),
    [report, setReport] = useState<Report | null>(null),
    [items, setItems] = useState<Item[]>([]),
    [codes, setCodes] = useState<DividendCode[]>([]),
    [securities, setSecurities] = useState<{ id: string; name: string }[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [linkError, setLinkError] = useState(''),
    [version, setVersion] = useState(0),
    [edit, setEdit] = useState<DividendRecord | null | undefined>(undefined),
    [remove, setRemove] = useState<DividendRecord | null>(null),
    [confirmReplay, setConfirmReplay] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setFrom(from);
    setTo(to);
  }, [from, to]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    const q = new URLSearchParams({
      date_from: from,
      date_to: to,
      ...(selected ? { security_id: selected } : {}),
    });
    void Promise.all([
      api<Report>(base + '/reports/dividends?' + q),
      api<Item[]>(base + '/items?include_archived=true'),
      api<{ items: DividendCode[] }>(base + '/income-codes'),
      api<{ id: string; name: string }[]>(base + '/securities'),
    ])
      .then(([r, i, c, s]) => {
        if (live) {
          setReport(r);
          setItems(i);
          setCodes(c.items);
          setSecurities(s);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [base, from, to, selected, version]);
  useEffect(() => {
    let live = true;
    setLinkError('');
    if (linkedId) {
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(linkedId))
        setLinkError('股利連結格式不正確。');
      else
        void api<DividendRecord>(base + '/dividends/' + linkedId)
          .then((row) => {
            if (live) setEdit(row);
          })
          .catch((e) => {
            if (live) setLinkError(errorMessage(e));
          });
    }
    return () => {
      live = false;
    };
  }, [base, linkedId]);
  function closeEdit() {
    setEdit(undefined);
    if (linkedId) {
      const url = new URL(location, 'https://local.invalid');
      url.searchParams.delete('dividend_id');
      navigate(url.pathname + url.search, true);
    }
  }
  function generate() {
    navigate(
      '/investments?' +
        new URLSearchParams({
          view: 'dividends',
          date_from: dateFrom,
          date_to: dateTo,
          ...(selected ? { security_id: selected } : {}),
        }),
    );
  }
  const [deletePlan, setDeletePlan] = useState<{
    preview_hash: string;
    recalculations: {
      trade_date: string;
      old_gain: string;
      new_gain: string;
    }[];
  } | null>(null);
  async function prepareDelete(d: DividendRecord) {
    setBusy(true);
    setError('');
    try {
      const p = await api<NonNullable<typeof deletePlan>>(
        base + '/dividend-preview',
        'POST',
        { operation: 'delete', id: d.id },
      );
      setDeletePlan(p);
      setRemove(d);
      setConfirmReplay(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function deleteDividend() {
    if (!remove || !deletePlan) return;
    setBusy(true);
    try {
      await api(base + '/dividends/' + remove.id, 'DELETE', {
        preview_hash: deletePlan.preview_hash,
        confirm_recalculation: confirmReplay,
      });
      setRemove(null);
      setVersion((v) => v + 1);
      notify('股利及配股已刪除');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack>
      <Group justify="space-between">
        <h2>股利收入</h2>
        <Button
          onClick={() => setEdit(null)}
          disabled={loading || busy || !securities.length}
        >
          新增股利
        </Button>
      </Group>
      <Text size="sm">
        代碼與名稱以集保結算所／發行機構通知為準；是否應稅由使用者依通知確認。
      </Text>
      <Button
        variant="light"
        onClick={() => navigate('/admin/investment-settings?tab=codes')}
      >
        所得代碼
      </Button>
      {error && (
        <ErrorState message={error} retry={() => setVersion((v) => v + 1)} />
      )}
      {loading ? (
        <LoadingState label="載入股利" />
      ) : (
        <>
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              generate();
            }}
          >
            <Group align="end">
              <TextInput
                label="股利起日"
                type="date"
                value={dateFrom}
                onChange={(e) => setFrom(e.currentTarget.value)}
              />
              <TextInput
                label="股利迄日"
                type="date"
                value={dateTo}
                onChange={(e) => setTo(e.currentTarget.value)}
              />
              <Button type="submit">產生股利報表</Button>
            </Group>
          </form>
          {report && (
            <>
              <div className="stock-grid">
                {(['gross_amount', 'net_amount'] as const).map((k, i) => (
                  <section className="panel" key={k}>
                    <Text>{i ? '實發合計' : '應發合計'}</Text>
                    <strong className="money">
                      {formatMoney(report.totals[k])}
                    </strong>
                  </section>
                ))}
              </div>
              {!report.items.length ? (
                <EmptyState title="期間內沒有股利" />
              ) : (
                <>
                  <section className="panel">
                    <h3>依代碼彙總</h3>
                    {report.codes.map((c) => (
                      <p key={c.code}>
                        {c.code}{' '}
                        <span className="money">{formatMoney(c.amount)}</span>
                        ・標記應稅 {formatMoney(c.taxable_amount)}
                      </p>
                    ))}
                  </section>
                  {report.items.map((d) => (
                    <article className="panel" key={d.id}>
                      <h3>
                        {securities.find((s) => s.id === d.security_id)?.name}
                      </h3>
                      <p>
                        除權息 {d.ex_date}・發放 {d.pay_date}
                      </p>
                      <p>
                        參與 {d.shares} 股・配股 {d.stock_shares} 股
                      </p>
                      <p className="money">
                        應發 {formatMoney(d.gross_amount)}・實發{' '}
                        {formatMoney(d.net_amount)}
                      </p>
                      {d.note && <p>{d.note}</p>}
                      <Group>
                        <Button
                          variant="light"
                          onClick={() => setEdit(d)}
                          aria-label={'編輯股利 ' + d.pay_date}
                        >
                          編輯
                        </Button>
                        <Button
                          variant="subtle"
                          onClick={() => {
                            void prepareDelete(d);
                          }}
                          aria-label={'刪除股利 ' + d.pay_date}
                        >
                          刪除
                        </Button>
                      </Group>
                    </article>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
      {linkError && <ErrorState message={linkError} />}
      {edit !== undefined && (
        <DividendEntry
          key={edit?.id ?? 'new'}
          ledger={ledger.id}
          securities={securities}
          items={items}
          codes={codes}
          defaults={{}}
          initial={edit}
          security={selected}
          onClose={closeEdit}
          onSaved={() => {
            closeEdit();
            setVersion((v) => v + 1);
          }}
        />
      )}
      <ConfirmDialog
        opened={!!remove}
        title="刪除股利與同次配股？"
        confirmLabel="確認刪除"
        busy={busy}
        onCancel={() => setRemove(null)}
        onConfirm={() => void deleteDividend()}
      >
        <Text>相關交易會一併刪除，後續持股成本可能重算。</Text>
        {deletePlan?.recalculations.map((r, i) => (
          <Text key={i}>
            {r.trade_date} 損益 {formatMoney(r.old_gain)} →{' '}
            {formatMoney(r.new_gain)}
          </Text>
        ))}
        <Checkbox
          label="我已確認刪除及後續重算"
          checked={confirmReplay}
          onChange={(e) => setConfirmReplay(e.currentTarget.checked)}
        />
      </ConfirmDialog>
    </Stack>
  );
}
