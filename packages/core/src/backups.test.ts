// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson, backupFilename } from './backups.js';
it('canonical JSON sorts keys recursively including numeric-like keys and preserves array order', () => {
  const a = {
    z: [{ b: '10.000000', a: '0.1234567890' }, null, true],
    a: { '2': 'two', '10': 'ten' },
  };
  const text = canonicalJson(a);
  expect(text).toBe(
    '{"a":{"10":"ten","2":"two"},"z":[{"a":"0.1234567890","b":"10.000000"},null,true]}',
  );
  expect(createHash('sha256').update(text).digest('hex')).toBe(
    createHash('sha256')
      .update(
        canonicalJson({
          a: { '10': 'ten', '2': 'two' },
          z: [{ a: '0.1234567890', b: '10.000000' }, null, true],
        }),
      )
      .digest('hex'),
  );
  expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
});
it('canonical JSON rejects undefined/nonfinite/cycles and deeply nested payloads', () => {
  expect(() => canonicalJson({ a: undefined })).toThrow('invalid_backup');
  expect(() => canonicalJson(NaN)).toThrow('invalid_backup');
  let deep: unknown = null;
  for (let i = 0; i < 105; i++) deep = { a: deep };
  expect(() => canonicalJson(deep)).toThrow('invalid_backup');
  const cyclic: Record<string, unknown> = {};
  cyclic.a = cyclic;
  expect(() => canonicalJson(cyclic)).toThrow('invalid_backup');
});
it('backup filename slug is safe, Unicode-aware, fallback present and uses Taipei time', () => {
  expect(
    backupFilename('../合成 / 帳本\r\n"', '2026-10-17T23:01:02.000Z'),
  ).toBe('finmichi-合成-帳本-20261018-070102.json');
  expect(backupFilename('///', '2026-10-17T00:00:00Z')).toBe(
    'finmichi-ledger-20261017-080000.json',
  );
});
