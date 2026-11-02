// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema, itemCreateSchema } from './catalog-schemas.js';
export const life2023Headers = [
  '記錄日期',
  '來源項目',
  '目的帳目',
  '異動金額',
  '摘要',
  '收付人',
  '專案代號',
  '發票號碼',
] as const;
export const importItemChoice = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('existing'), id: idSchema }),
  z.strictObject({
    mode: z.literal('create'),
    data: itemCreateSchema.omit({
      currency: true,
      archived: true,
      securities: true,
    }),
  }),
]);
export const importNamedChoice = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('existing'), id: idSchema }),
  z.strictObject({ mode: z.literal('create') }),
  z.strictObject({ mode: z.literal('blank') }),
]);
export const life2023InputSchema = z.strictObject({
  file_base64: z
    .string()
    .min(4)
    .max(5592408)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  encoding: z.enum(['auto', 'utf-8', 'big5']).default('auto'),
  item_mappings: z.record(z.string().max(224), importItemChoice).default({}),
  payee_mappings: z.record(z.string().max(200), importNamedChoice).default({}),
  project_mappings: z
    .record(z.string().max(200), importNamedChoice)
    .default({}),
  skip_invalid: z.boolean().default(false),
});
export type Life2023Input = z.infer<typeof life2023InputSchema>;
export type ItemChoice = z.infer<typeof importItemChoice>;
export type NamedChoice = z.infer<typeof importNamedChoice>;
export interface ImportIssue {
  field: string;
  code: string;
}
export interface ImportRow {
  line: number;
  cells: string[];
  occurred_on: string | null;
  amount: string | null;
  errors: ImportIssue[];
  suspected_duplicate: boolean;
}
export interface ItemMappingGroup {
  key: string;
  name: string;
  field: 'source' | 'destination';
  candidates: { id: string; name: string; kind: string; currency: string }[];
  selection: ItemChoice | null;
}
export interface NamedMappingGroup {
  key: string;
  name: string;
  candidates: { id: string; name: string }[];
  selection: NamedChoice;
}
export interface Life2023Preview {
  source_sha256: string;
  encoding: 'utf-8' | 'big5';
  rows: ImportRow[];
  importable_count: number;
  error_count: number;
  suspected_duplicate_count: number;
  total_amount: string;
  item_groups: ItemMappingGroup[];
  payee_groups: NamedMappingGroup[];
  project_groups: NamedMappingGroup[];
  pending_creates: { items: number; payees: number; projects: number };
  already_imported: boolean;
}

export interface Life2023Export {
  csv: string;
  exported_count: number;
  skipped_count: number;
  skip_reasons: {
    code: 'multiple_entries' | 'foreign_currency';
    count: number;
  }[];
}
