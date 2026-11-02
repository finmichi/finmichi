// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button } from '@mantine/core';
import { api, errorMessage } from '../api';
import { useWorkspace } from './workspace';
import { LoadingState, ErrorState } from './feedback';
export function SystemPage({
  subject,
  onLogout,
}: {
  subject: string;
  onLogout: () => void;
}) {
  const { current } = useWorkspace();
  const [version, setVersion] = useState(''),
    [date, setDate] = useState('—'),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<{ version: string }>('/api/health'),
      current
        ? api<{ items: { occurred_on: string }[] }>(
            `/api/ledgers/${current.id}/transactions?limit=1`,
          )
        : Promise.resolve({ items: [] }),
    ])
      .then(([r, q]) => {
        if (live) {
          setVersion(r.version);
          setDate(q.items[0]?.occurred_on ?? '尚無交易');
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [retry, current?.id]);
  return (
    <section className="panel">
      <h2>系統資訊</h2>
      {error ? (
        <ErrorState
          message={error}
          retry={() => {
            setError('');
            setRetry((v) => v + 1);
          }}
        />
      ) : !version ? (
        <LoadingState label="載入系統資訊" />
      ) : (
        <dl className="system-info">
          <dt>版本</dt>
          <dd>{version}</dd>
          <dt>登入身分</dt>
          <dd>{subject}</dd>
          <dt>本位幣</dt>
          <dd>{current?.base_currency ?? '—'}</dd>
          <dt>時區</dt>
          <dd>Asia/Taipei</dd>
          <dt>資料日期</dt>
          <dd>{date}</dd>
        </dl>
      )}
      <Button onClick={onLogout}>登出</Button>
    </section>
  );
}
