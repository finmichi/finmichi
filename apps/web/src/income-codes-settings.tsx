// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { useEffect, useState } from 'react';
import { Button, Stack, Text, TextInput } from '@mantine/core';
import type { Ledger, Item } from '@finmichi/core/catalog-schemas';
import type { DividendCode } from './dividend-entry';
import { api, errorMessage } from './api';
import { ErrorState, LoadingState, notify } from './design/feedback';
export function IncomeCodesSettings({ ledger }: { ledger: Ledger }) {
  const base = `/api/ledgers/${ledger.id}`;
  const [codeId, setCodeId] = useState<string | null>(null),
    [code, setCode] = useState(''),
    [label, setLabel] = useState(''),
    [income, setIncome] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]),
    [codes, setCodes] = useState<DividendCode[]>([]),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([
      api<Item[]>(base + '/items?include_archived=true'),
      api<{ items: DividendCode[] }>(base + '/income-codes'),
    ])
      .then(([i, c]) => {
        if (live) {
          setItems(i);
          setCodes(c.items);
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
  }, [base, version]);
  async function initialize() {
    setBusy(true);
    try {
      await api(base + '/income-codes/initialize', 'POST');
      setVersion((v) => v + 1);
      notify('預設科目與範例代碼已建立');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveCode() {
    setBusy(true);
    try {
      await api(
        base + '/income-codes' + (codeId ? '/' + codeId : ''),
        codeId ? 'PUT' : 'POST',
        { code, label, income_item_id: income },
      );
      setCodeId(null);
      setCode('');
      setLabel('');
      setIncome(null);
      setVersion((v) => v + 1);
      notify('所得代碼已儲存');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack>
      <Text size="sm">
        代碼與名稱以集保結算所／發行機構通知為準；是否應稅由使用者依通知確認。
      </Text>
      <Button variant="light" disabled={busy} onClick={() => void initialize()}>
        建立預設代碼與科目
      </Button>
      {error && (
        <ErrorState message={error} retry={() => setVersion((v) => v + 1)} />
      )}
      {loading ? (
        <LoadingState label="載入所得代碼" />
      ) : (
        <>
          <Stack>
            <section className="panel">
              <Stack>
                <TextInput
                  label="所得代碼"
                  disabled={busy}
                  value={code}
                  onChange={(e) => setCode(e.currentTarget.value)}
                />
                <TextInput
                  label="代碼名稱"
                  disabled={busy}
                  value={label}
                  onChange={(e) => setLabel(e.currentTarget.value)}
                />
                <ItemPicker
                  items={items}
                  label="代碼預設收入科目"
                  disabled={busy}
                  clearable
                  value={income}
                  onChange={setIncome}
                  data={items
                    .filter(
                      (i) =>
                        i.kind === 'income' &&
                        i.currency === 'TWD' &&
                        !i.archived,
                    )
                    .map((i) => ({ value: i.id, label: i.name }))}
                />
                <Button
                  disabled={busy || !code || !label}
                  onClick={() => void saveCode()}
                >
                  儲存所得代碼
                </Button>
              </Stack>
            </section>
            {codes.map((c) => (
              <article className="panel" key={c.id}>
                <strong>
                  {c.code}・{c.label}
                </strong>
                <Text>
                  {items.find((i) => i.id === c.income_item_id)?.name ??
                    '使用股利預設科目'}
                </Text>
                <Button
                  variant="light"
                  onClick={() => {
                    setCodeId(c.id);
                    setCode(c.code);
                    setLabel(c.label);
                    setIncome(c.income_item_id);
                  }}
                >
                  編輯代碼 {c.code}
                </Button>
              </article>
            ))}
          </Stack>
        </>
      )}
    </Stack>
  );
}
