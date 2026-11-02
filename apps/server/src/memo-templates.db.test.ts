// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { namedRecordService } from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
import { namedContract } from '../test/named-contract.js';
namedContract('memo_templates');
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture('memo-content');
});
afterAll(async () => {
  if (f) await f.close();
});
it('validates required memo and preserves independent name/memo/archive partial updates', async () => {
  const service = namedRecordService(f.db, 'memo_templates');
  for (const memo of [undefined, '', ' ', 42, 'x'.repeat(2001)])
    await expect(
      service.create(f.actor, f.ledger, { name: 'Synthetic memo', memo }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  const row = await service.create(f.actor, f.ledger, {
    name: 'Synthetic content',
    memo: "合成摘要\n<script>synthetic</script> ' ;",
    archived: true,
  });
  const changed = await service.update(f.actor, f.ledger, row.id, {
    name: 'Synthetic renamed content',
  });
  expect(changed.memo).toBe(row.memo);
  expect(changed.archived).toBe(true);
  const text = await service.update(f.actor, f.ledger, row.id, {
    memo: '合成修改\n第二行',
  });
  expect(text.memo).toBe('合成修改\n第二行');
  expect(text.name).toBe(changed.name);
  expect(text.archived).toBe(true);
  await expect(
    service.update(f.actor, f.ledger, row.id, { memo: '' }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});
