// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readBundle } from './bundle.js';
import { mappingSchema, planSchema } from './schema.js';
import { transform, validatePlanSourceKeys } from './transform.js';
import { validatedPlan } from './import.js';
const fixture = fileURLToPath(new URL('../fixtures/', import.meta.url));
const mapping = mappingSchema.parse({});

it('shared ACCOUNT_ID/MAKE_NO never identifies openings; trimmed source pair does', async () => {
  const b = await readBundle(fixture);
  for (const r of b.tables.get('ITEM_DATA')!) {
    r.ACCOUNT_ID = 'shared';
    r.MAKE_NO = 'shared';
    r.ITEM_CLASS = ` ${r.ITEM_CLASS} `;
    r.ITEM_NOTE = ` ${r.ITEM_NOTE} `;
  }
  const p = transform(b, mapping, null);
  expect(p.report.errors).toEqual([]);
  const openings = p.transactions.filter((t) =>
    t.source_key.endsWith(':opening'),
  );
  expect(openings).toHaveLength(3);
  expect(new Set(openings.map((t) => t.source_key)).size).toBe(3);
  for (const t of openings) {
    const r = b.tables
      .get('ITEM_DATA')!
      .find(
        (r) =>
          t.source_key ===
          `ITEM_DATA:${r.ITEM_CLASS!.trim()}|${r.ITEM_NOTE!.trim()}:opening`,
      );
    expect(r).toBeDefined();
  }
  expect(validatedPlan(p)).toEqual(p);
});
it('missing ACCOUNT_ID/MAKE_NO is allowed for opening source identity', async () => {
  const b = await readBundle(fixture);
  for (const r of b.tables.get('ITEM_DATA')!) {
    delete r.ACCOUNT_ID;
    delete r.MAKE_NO;
  }
  const p = transform(b, mapping, null);
  expect(p.report.errors).toEqual([]);
  expect(
    p.transactions.filter((t) => t.source_key.endsWith(':opening')),
  ).toHaveLength(3);
});
it('duplicate trimmed item identity is fatal even without opening balances or valid mapping', async () => {
  for (const invalidMapping of [false, true]) {
    const b = await readBundle(fixture);
    const r = { ...b.tables.get('ITEM_DATA')![0]!, BEFORE_MOUNT: '0' };
    if (invalidMapping) r.ITEM_CLASS = 'unknown-synthetic';
    b.tables.set('ITEM_DATA', [
      r,
      {
        ...r,
        ITEM_CLASS: ` ${r.ITEM_CLASS} `,
        ITEM_NOTE: ` ${r.ITEM_NOTE} `,
        ACCOUNT_ID: 'different',
      },
    ]);
    const p = transform(b, mapping, null);
    expect(p.report.errors).toContainEqual({
      code: 'duplicate_item_identity',
      table: 'ITEM_DATA',
      row: 2,
      key: '',
    });
    expect(() => validatedPlan(p)).toThrow('import_has_errors');
  }
});
it('same name with different source class is not a duplicate identity', async () => {
  const b = await readBundle(fixture);
  b.tables.set('ITEM_DATA', [
    { ITEM_CLASS: '資產', ITEM_NOTE: '同名', BEFORE_MOUNT: '1' },
    { ITEM_CLASS: '負債', ITEM_NOTE: '同名', BEFORE_MOUNT: '-1' },
  ]);
  b.tables.set('MYMONEY_DATA', []);
  const p = transform(b, mapping, null);
  expect(p.report.errors).toEqual([]);
  expect(p.transactions.map((t) => t.source_key)).toEqual([
    'ITEM_DATA:資產|同名:opening',
    'ITEM_DATA:負債|同名:opening',
  ]);
});
it('transform detects a transaction-group/opening key collision and reports class/count without contents', async () => {
  const b = await readBundle(fixture);
  const r = b.tables
    .get('ITEM_DATA')!
    .find((r) => r.ITEM_CLASS === '資產' && r.BEFORE_MOUNT !== '0')!;
  const collision = `ITEM_DATA:${r.ITEM_CLASS}|${r.ITEM_NOTE}:opening`;
  const firstKey = b.tables.get('MYMONEY_DATA')![0]!.DATA_KEY;
  for (const row of b.tables.get('MYMONEY_DATA')!)
    if (row.DATA_KEY === firstKey) row.DATA_KEY = collision;
  const p = transform(b, mapping, null);
  expect(p.report.errors).toEqual([
    {
      code: 'duplicate_source_key',
      table: 'ITEM_DATA',
      row: 0,
      key: '',
      count: 2,
    },
  ]);
  expect(JSON.stringify(p.report.errors)).not.toContain(collision);
  expect(planSchema.safeParse(p).success).toBe(true);
  expect(() => validatedPlan(p)).toThrow('import_has_errors');
});
it('plan-wide validator covers any transaction source key, reports every duplicate and count; apply defense retained', async () => {
  const p = transform(await readBundle(fixture), mapping, null);
  const opening = p.transactions[0]!,
    ordinary = p.transactions.find((t) => !t.source_key.endsWith(':opening'))!;
  p.transactions.push(
    structuredClone(opening),
    structuredClone(ordinary),
    structuredClone(ordinary),
  );
  expect(() => validatedPlan(p)).toThrow('duplicate_source_key');
  validatePlanSourceKeys(p);
  expect(p.report.errors).toEqual([
    {
      code: 'duplicate_source_key',
      table: 'ITEM_DATA',
      row: 0,
      key: '',
      count: 2,
    },
    {
      code: 'duplicate_source_key',
      table: 'MYMONEY_DATA',
      row: 0,
      key: '',
      count: 3,
    },
  ]);
});
