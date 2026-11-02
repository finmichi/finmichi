// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema } from './catalog-schemas.js';
export const patCreateSchema = z.strictObject({
  scope: z.enum(['read', 'draft']).default('read'),
  expires_in_days: z.number().int().min(1).max(90),
  ledger_ids: z
    .array(idSchema)
    .min(1)
    .max(1000)
    .refine((v) => new Set(v).size === v.length)
    .nullable()
    .default(null),
  mask_text: z.boolean().default(true),
});
export interface PersonalAccessToken {
  id: string;
  token_prefix: string;
  scope: 'read' | 'draft';
  ledger_ids: string[] | null;
  mask_text: boolean;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
