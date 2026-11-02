// SPDX-License-Identifier: AGPL-3.0-only
import { migrateLegacyPreferences } from './storage-migration';
import { queuePaymentPrefill, type PaymentPrefill } from './entry-prefill';
import type { TransactionInput } from '@finmichi/core/transaction-schemas';
import { useSyncExternalStore } from 'react';
// One listener precedes all React subscriptions. Window target listeners run in
// registration order, so a later capture listener cannot protect a dirty editor.
let acceptedLocation =
  typeof window === 'undefined'
    ? '/'
    : window.location.pathname + window.location.search;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
type NavigationGuard = (proceed: () => void) => void;
let navigationGuard: NavigationGuard | null = null;
function publish() {
  acceptedLocation = window.location.pathname + window.location.search;
  for (const cb of [...listeners]) cb();
}
if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    if (window.location.pathname + window.location.search === acceptedLocation)
      return;
    if (!navigationGuard) {
      publish();
      return;
    }
    let proceeded = false,
      restored = false;
    navigationGuard(() => {
      proceeded = true;
      if (restored) window.history.back();
      else publish();
    });
    if (!proceeded) {
      window.history.pushState(null, '', acceptedLocation);
      restored = true;
    }
  });
export function guardNavigation(guard: NavigationGuard) {
  navigationGuard = guard;
  return () => {
    if (navigationGuard === guard) navigationGuard = null;
  };
}
export function navigate(to: string, replace = false, accepted?: () => void) {
  if (!to.startsWith('/') || to.startsWith('//')) return;
  if (to === acceptedLocation) {
    accepted?.();
    return;
  }
  const proceed = () => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
    accepted?.();
    publish();
  };
  if (navigationGuard) navigationGuard(proceed);
  else proceed();
}
export function entryUrl(location: string, id: string | null) {
  const url = new URL(location, 'https://local.invalid');
  if (id) url.searchParams.set('entry', id);
  else url.searchParams.delete('entry');
  return url.pathname + url.search;
}
export function openEntry(id = 'new') {
  navigate(entryUrl(window.location.pathname + window.location.search, id));
}
export const useLocation = () =>
  useSyncExternalStore(subscribe, () => acceptedLocation);
export function readPreference(key: string) {
  try {
    migrateLegacyPreferences(window.localStorage);
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Storage is optional; app state remains authoritative. */
  }
}

// Keep keyboard intent until a lazy query route actually mounts its input.
let querySearchFocusPending = false;
export function applyQuerySearchFocus(node: HTMLInputElement | null): void {
  if (node && querySearchFocusPending) {
    querySearchFocusPending = false;
    node.focus();
  }
}
export function focusQuerySearch() {
  const to =
    acceptedLocation.split('?')[0] === '/transactions'
      ? entryUrl(acceptedLocation, null)
      : '/transactions';
  navigate(to, false, () => {
    querySearchFocusPending = true;
    requestAnimationFrame(() =>
      applyQuerySearchFocus(
        document.querySelector<HTMLInputElement>('[data-query-search]'),
      ),
    );
  });
}

export function openPaymentEntry(
  ledgerId: string,
  input: TransactionInput,
  mode: PaymentPrefill['mode'] = 'advanced',
  notice?: string,
) {
  navigate(
    entryUrl(window.location.pathname + window.location.search, 'new'),
    false,
    () => {
      queuePaymentPrefill(ledgerId, input, mode, notice);
    },
  );
}
