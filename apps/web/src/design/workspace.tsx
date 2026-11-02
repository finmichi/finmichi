// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { api, errorMessage } from '../api';
import { readPreference, writePreference } from './location';
interface Scope {
  ledgers: Ledger[];
  selected: string | null;
  current: Ledger | undefined;
  select: (id: string | null) => void;
  refresh: (id?: string) => Promise<void>;
  error: string;
  loading: boolean;
}
const Context = createContext<Scope | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [ledgers, setLedgers] = useState<Ledger[]>([]),
    [selected, setSelected] = useState<string | null>(() =>
      readPreference('finmichi-ledger'),
    ),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  function select(id: string | null) {
    setSelected(id);
    if (id) writePreference('finmichi-ledger', id);
  }
  async function refresh(preferred?: string) {
    setError('');
    try {
      const rows = await api<Ledger[]>('/api/ledgers');
      setLedgers(rows);
      setSelected((old) => {
        const id =
          rows.find((l) => l.id === (preferred ?? old))?.id ??
          rows[0]?.id ??
          null;
        if (id) writePreference('finmichi-ledger', id);
        return id;
      });
      setLoading(false);
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }
  useEffect(() => {
    let live = true;
    void api<Ledger[]>('/api/ledgers')
      .then((rows) => {
        if (live) {
          setLedgers(rows);
          setSelected((old) => {
            const id =
              rows.find((l) => l.id === old)?.id ?? rows[0]?.id ?? null;
            if (id) writePreference('finmichi-ledger', id);
            return id;
          });
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
  }, []);
  return (
    <Context.Provider
      value={{
        ledgers,
        selected,
        current: ledgers.find((l) => l.id === selected),
        select,
        refresh,
        error,
        loading,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const scope = useContext(Context);
  if (!scope) throw new Error('Workspace provider required');
  return scope;
}
