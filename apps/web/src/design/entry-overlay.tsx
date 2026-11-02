// SPDX-License-Identifier: AGPL-3.0-only
import { ConfirmDialog } from './feedback';
import { api } from '../api';
import { readPaymentPrefill, acknowledgePaymentPrefill } from './entry-prefill';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Drawer, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { Transactions } from '../transactions';
import { entryUrl, guardNavigation, navigate, useLocation } from './location';
export function EntryOverlay({
  ledger,
  entry,
  onSaved,
}: {
  ledger: Ledger;
  entry: string;
  onSaved: (message: string) => void;
}) {
  const mobile = useMediaQuery('(max-width: 899px)', false, {
    getInitialValueInEffect: false,
  });
  const [initialPayment] = useState(() =>
    entry === 'new' ? readPaymentPrefill(ledger.id) : null,
  );
  useLayoutEffect(() => {
    acknowledgePaymentPrefill(initialPayment);
  }, [initialPayment]);
  const location = useLocation(),
    dirty = useRef(false),
    busy = useRef(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement,
  );
  const request = useCallback((proceed: () => void) => {
    if (busy.current) return;
    if (dirty.current) setPending(() => proceed);
    else proceed();
  }, []);
  const onDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const onBusy = useCallback((value: boolean) => {
    busy.current = value;
  }, []);
  useLayoutEffect(() => guardNavigation(request), [request]);
  useLayoutEffect(() => {
    return () => {
      requestAnimationFrame(() => {
        if (trigger.current?.isConnected)
          trigger.current.focus({ preventScroll: true });
        else
          document
            .querySelector<HTMLElement>('[aria-label="主內容"]')
            ?.focus({ preventScroll: true });
      });
    };
  }, []);
  useLayoutEffect(() => {
    function unload(event: BeforeUnloadEvent) {
      if (dirty.current || busy.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('beforeunload', unload);
    };
  }, [location, request]);
  return (
    <>
      <Drawer
        opened
        onClose={() => navigate(entryUrl(location, null))}
        position="right"
        size={mobile ? '100%' : 420}
        title={entry === 'new' ? '記一筆' : '修改交易'}
        closeOnEscape={!pending}
        closeOnClickOutside={!pending}
        closeButtonProps={{ 'aria-label': '關閉記帳', size: 44 }}
        classNames={{
          content: 'entry-drawer-content',
          body: 'entry-drawer-body',
          header: 'entry-drawer-header',
        }}
      >
        {initialPayment?.notice && (
          <p className="finance-warning" role="status">
            {initialPayment.notice}
          </p>
        )}
        <Transactions
          ledger={ledger}
          {...(initialPayment
            ? {
                draft: {
                  initial: initialPayment.input,
                  initialMode: initialPayment.mode,
                  label: '儲存繳款交易',
                  successMessage: '繳款交易已儲存。',
                  save: async (data) => {
                    await api(
                      `/api/ledgers/${ledger.id}/transactions`,
                      'POST',
                      data,
                    );
                  },
                },
              }
            : {})}
          initialEditId={entry === 'new' ? undefined : entry}
          onDirtyChange={onDirty}
          onBusyChange={onBusy}
          requestDiscard={request}
          onClose={() => navigate(entryUrl(location, null))}
          onSaved={(next, message) => {
            dirty.current = false;
            busy.current = false;
            onSaved(message);
            if (!next) navigate(entryUrl(location, null));
            else if (entry !== 'new') navigate(entryUrl(location, 'new'), true);
          }}
        />
      </Drawer>
      <ConfirmDialog
        opened={!!pending}
        onCancel={() => setPending(null)}
        title="未儲存內容"
        closeLabel="關閉未儲存確認"
        cancelLabel="繼續編輯"
        confirmLabel="捨棄變更"
        onConfirm={() => {
          const proceed = pending;
          setPending(null);
          dirty.current = false;
          proceed?.();
        }}
      >
        <Text>有未儲存的變更，確定要捨棄嗎？</Text>
      </ConfirmDialog>
    </>
  );
}
