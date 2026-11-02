// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import { useTransactionRevision } from './design/data-revision';
export function useReport<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    tx = useTransactionRevision();
  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    if (!url) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void api<T>(url)
      .then((v) => {
        if (live) setData(v);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [url, revision, tx]);
  return { data, error, busy, retry: () => setRevision((v) => v + 1) };
}
