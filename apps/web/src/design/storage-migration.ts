// SPDX-License-Identifier: AGPL-3.0-only
/** Move only missing preferences; never overwrite a preference already saved by FinMichi. */
export function migrateLegacyPreferences(storage: Storage): void {
  try {
    const keys = Array.from({ length: storage.length }, (_, i) =>
      storage.key(i),
    );
    for (const key of keys) {
      if (!key?.startsWith('life-ledger-')) continue;
      const next = 'finmichi-' + key.slice('life-ledger-'.length);
      try {
        if (storage.getItem(next) !== null) continue;
        const value = storage.getItem(key);
        if (value === null) continue;
        storage.setItem(next, value);
        storage.removeItem(key);
      } catch {
        // Quota/security failures must not delete the original preference.
      }
    }
  } catch {
    // Private browsing may disable storage entirely.
  }
}
