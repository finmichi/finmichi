// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
export function useTransactionRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((v) => v + 1);
    window.addEventListener('ledger:transactions-changed', changed);
    window.addEventListener('ledger:catalog-changed', changed);
    return () => {
      window.removeEventListener('ledger:transactions-changed', changed);
      window.removeEventListener('ledger:catalog-changed', changed);
    };
  }, []);
  return revision;
}
