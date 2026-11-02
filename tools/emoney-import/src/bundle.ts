// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { dateSchema, ImportError, mappingSchema, type Row } from './schema.js';
export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export interface Bundle {
  sourceSha256: string;
  sourceDate: string;
  exportedAt: string;
  tables: Map<string, Row[]>;
}
export async function readLimited(path: string, max = 50 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new ImportError('file_invalid_or_too_large');
  const data = await readFile(path);
  if (data.length > max) throw new ImportError('file_invalid_or_too_large');
  return data;
}
export async function readMapping(path?: string) {
  if (!path) return { mapping: mappingSchema.parse({}), mappingSha256: null };
  const data = await readLimited(path, 1024 * 1024);
  return {
    mapping: mappingSchema.parse(JSON.parse(data.toString('utf8'))),
    mappingSha256: sha256(data),
  };
}
export async function readBundle(directory: string): Promise<Bundle> {
  const root = await realpath(directory);
  const manifest = (
    await readLimited(join(root, 'manifest.txt'), 1024 * 1024)
  ).toString('utf8');
  const lines = manifest.trim().split(/\r?\n/),
    first = lines.shift()?.split('|');
  if (
    first?.[0] !== 'SOURCE_SHA256' ||
    !/^([a-f0-9]{64})$/.test(first[1] ?? '')
  )
    throw new ImportError('invalid_manifest');
  const sourceSha256 = first[1]!,
    date = lines.shift()?.split('|');
  if (
    date?.length !== 2 ||
    date[0] !== 'SOURCE_DATE' ||
    !dateSchema.safeParse(date[1]).success
  )
    throw new ImportError('invalid_source_date');
  const exported = lines.shift()?.split('|');
  if (
    exported?.length !== 2 ||
    exported[0] !== 'EXPORTED_AT' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(exported[1] ?? '') ||
    Number.isNaN(Date.parse(exported[1]!))
  )
    throw new ImportError('invalid_export_date');
  const tables = new Map<string, Row[]>();
  let total = 0;
  for (const line of lines) {
    const cells = line.split('|'),
      [table, count, hash] = cells;
    if (
      cells.length !== 3 ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(table ?? '') ||
      !/^\d+$/.test(count ?? '') ||
      !/^[a-f0-9]{64}$/.test(hash ?? '')
    )
      throw new ImportError('invalid_manifest');
    const name = table!.toUpperCase();
    if (tables.has(name)) throw new ImportError('duplicate_table');
    const path = resolve(root, table!.toLowerCase() + '.csv');
    if (!path.startsWith(root + '/')) throw new ImportError('invalid_manifest');
    const data = await readLimited(path);
    total += data.length;
    if (total > 200 * 1024 * 1024) throw new ImportError('bundle_too_large');
    if (sha256(data) !== hash) throw new ImportError('csv_checksum_mismatch');
    const rows = parse(new TextDecoder('utf-8', { fatal: true }).decode(data), {
      bom: true,
      columns: (headers: string[]) => {
        const h = headers.map((s) => s.trim().toUpperCase());
        if (new Set(h).size !== h.length || h.some((x) => !x))
          throw new ImportError('invalid_header');
        return h;
      },
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 1024 * 1024,
    }) as Row[];
    if (BigInt(rows.length) !== BigInt(count!))
      throw new ImportError('row_count_mismatch');
    if (rows.length > 200000) throw new ImportError('too_many_rows');
    tables.set(name, rows);
  }
  if (!tables.has('ITEM_DATA') || !tables.has('MYMONEY_DATA'))
    throw new ImportError('required_table_missing');
  return {
    sourceSha256,
    sourceDate: date[1]!,
    exportedAt: exported[1]!,
    tables,
  };
}
