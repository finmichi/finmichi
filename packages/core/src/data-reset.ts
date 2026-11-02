// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, ownedLedger, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';

// Dependency order, not just the backup allowlist: drafts and worker state also
// belong to a ledger. Unknown tables fail closed until explicitly classified.
export const deletionLedgerTables = [
  'dividend_components',
  'dividends',
  'deposit_postings',
  'fixed_deposits',
  'security_trades',
  'securities',
  'manual_prices',
  'income_codes',
  'transaction_drafts',
  'recurring_occurrences',
  'recurring_rules',
  'recurring_worker_runs',
  'credit_card_settings',
  'loan_settings',
  'budgets',
  'reminder_reads',
  'reminder_settings',
  'import_source_records',
  'import_jobs',
  'transaction_entries',
  'transactions',
  'exchange_rates',
  'memo_templates',
  'payees',
  'projects',
  'items',
] as const;
export const deletionPreservedTables = [
  'users',
  'audit_logs',
  'schema_migrations',
  'market_fx_rates',
  'market_prices',
  'market_calendar',
  'market_fetch_runs',
] as const;
export const deletionOwnerTables = [
  'sessions',
  'personal_access_tokens',
  'data_reset_grants',
] as const;
export const deletionSchemaTables = [
  ...deletionLedgerTables,
  ...deletionPreservedTables,
  ...deletionOwnerTables,
  'ledgers',
].sort();
export async function assertDeletionSchema(sql: Transaction) {
  const rows = await sql<
    { table_name: string }[]
  >`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`;
  if (
    JSON.stringify(rows.map((r) => r.table_name)) !==
    JSON.stringify(deletionSchemaTables)
  )
    throw new DomainError('deletion_schema_incomplete', 503);
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const resetInputSchema = z.strictObject({
  backup_token: tokenSchema.optional(),
  confirmation: z.string().max(200),
});
export const resetBackupSchema = z.strictObject({ backup_token: tokenSchema });
const previewSchema = z.strictObject({});
export type DeletionMode = 'purge' | 'factory';
export interface DeletionBackupContext {
  backupToken: string;
  sessionToken: string;
}
interface Grant {
  token_hash: string;
  mode: DeletionMode;
  ledger_ids: string[];
  snapshots: Record<string, string>;
  counts: Record<string, number>;
  backups: Record<string, string>;
}
export async function deletionSession(
  sql: Transaction,
  actor: string,
  sessionToken: string | undefined,
  lock = false,
) {
  valid(idSchema, actor);
  if (!sessionToken || !tokenSchema.safeParse(sessionToken).success)
    throw new DomainError('browser_session_required', 403);
  if (lock) await sql`SELECT id FROM users WHERE id=${actor} FOR NO KEY UPDATE`;
  const sessionHash = hash(sessionToken);
  const [session] =
    await sql`SELECT reauthenticated AND authenticated_at<=clock_timestamp() AND authenticated_at>=clock_timestamp()-interval '5 minutes' AS recent_auth,
    to_char((authenticated_at+interval '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reauth_expires_at
    FROM sessions WHERE token_hash=${sessionHash} AND user_id=${actor} AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '1 day'`;
  if (!session) throw new DomainError('browser_session_required', 403);
  return {
    sessionHash,
    recent_auth: session.recent_auth === true,
    reauth_expires_at: session.reauth_expires_at as string | null,
  };
}
async function grantFor(
  sql: Transaction,
  actor: string,
  sessionHash: string,
  token: string | undefined,
) {
  if (!token) throw new DomainError('backup_token_required', 400);
  if (!tokenSchema.safeParse(token).success)
    throw new DomainError('backup_token_invalid', 403);
  const [grant] = await sql<
    Grant[]
  >`SELECT token_hash,mode,ledger_ids,snapshots,counts,backups FROM data_reset_grants
    WHERE token_hash=${hash(token)} AND user_id=${actor} AND session_hash=${sessionHash} AND expires_at>clock_timestamp() FOR UPDATE`;
  if (!grant) throw new DomainError('backup_token_invalid', 403);
  return grant;
}
async function ledgerSnapshot(sql: Transaction, ledger: string) {
  const counts: Record<string, number> = {},
    fingerprints: string[] = [];
  for (const table of [...deletionLedgerTables, 'ledgers'] as const) {
    const [r] = await sql`SELECT count(*)::integer AS n,
      encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex') AS h
      FROM ${sql(table)} t WHERE ${table === 'ledgers' ? sql`t.id` : sql`t.ledger_id`}=${ledger}`;
    counts[table] = Number(r!.n);
    fingerprints.push(table + ':' + String(r!.h));
  }
  return { counts, fingerprint: hash(fingerprints.join('\n')) };
}
async function scope(
  sql: Transaction,
  actor: string,
  ids: string[],
  mode: DeletionMode,
  sessionHash: string,
) {
  const ledgers = [],
    snapshots: Record<string, string> = {};
  const counts: Record<string, number> = Object.fromEntries(
    [...deletionLedgerTables, 'ledgers'].map((t) => [t, 0]),
  );
  for (const id of [...ids].sort()) {
    const ledger = await ownedLedger(sql, actor, id);
    ledgers.push(ledger);
    const snapshot = await ledgerSnapshot(sql, id);
    snapshots[id] = snapshot.fingerprint;
    for (const [table, n] of Object.entries(snapshot.counts))
      counts[table]! += n;
  }
  if (mode === 'factory') {
    const [s] =
      await sql`SELECT count(*)::integer AS n FROM sessions WHERE user_id=${actor} AND token_hash<>${sessionHash}`;
    const [p] =
      await sql`SELECT count(*)::integer AS n FROM personal_access_tokens WHERE user_id=${actor}`;
    counts.sessions = Number(s!.n);
    counts.personal_access_tokens = Number(p!.n);
  }
  // Exactly one user-scoped, session-bound grant exists after preview.
  counts.data_reset_grants = 1;
  return { ledgers, counts, snapshots };
}
async function ownerLedgers(sql: Transaction, actor: string) {
  return (
    await sql<
      { id: string }[]
    >`SELECT id FROM ledgers WHERE owner_id=${actor} ORDER BY id`
  ).map((r) => r.id);
}
export async function recordDeletionBackup(
  sql: Transaction,
  actor: string,
  ledger: string,
  context: DeletionBackupContext,
  payloadSha256: string,
) {
  const session = await deletionSession(sql, actor, context.sessionToken);
  const grant = await grantFor(
    sql,
    actor,
    session.sessionHash,
    context.backupToken,
  );
  if (!grant.ledger_ids.includes(ledger))
    throw new DomainError('backup_token_invalid', 403);
  const current = await ledgerSnapshot(sql, ledger);
  if (current.fingerprint !== grant.snapshots[ledger])
    throw new DomainError('preview_changed', 409);
  await sql`UPDATE data_reset_grants SET backups=${sql.json({ ...grant.backups, [ledger]: payloadSha256 })} WHERE token_hash=${grant.token_hash}`;
}
export function dataResetService(db: Database, allowFactoryReset = false) {
  const enabled = (mode: DeletionMode) => {
    if (mode === 'factory' && !allowFactoryReset)
      throw new DomainError('not_found', 404);
  };
  return {
    async status(actor: string, sessionToken: string | undefined) {
      return db.begin(async (sql) => {
        const s = await deletionSession(sql, actor, sessionToken);
        return {
          factory_reset: allowFactoryReset,
          recent_auth: s.recent_auth,
          reauth_expires_at: s.reauth_expires_at,
        };
      });
    },
    async preview(
      actor: string,
      sessionToken: string | undefined,
      mode: DeletionMode,
      ledgerId?: unknown,
      input: unknown = {},
    ) {
      enabled(mode);
      valid(previewSchema, input);
      return db.begin(async (sql) => {
        const session = await deletionSession(sql, actor, sessionToken, true);
        await assertDeletionSchema(sql);
        const ids =
          mode === 'purge'
            ? [valid(idSchema, ledgerId)]
            : await ownerLedgers(sql, actor);
        const current = await scope(sql, actor, ids, mode, session.sessionHash);
        const token = randomBytes(32).toString('base64url');
        await sql`DELETE FROM data_reset_grants WHERE user_id=${actor}`;
        const [grant] =
          await sql`INSERT INTO data_reset_grants(token_hash,user_id,session_hash,mode,ledger_ids,snapshots,counts,created_at,expires_at)
          VALUES (${hash(token)},${actor},${session.sessionHash},${mode},${ids},${sql.json(current.snapshots)},${sql.json(current.counts)},statement_timestamp(),statement_timestamp()+interval '10 minutes')
          RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at`;
        return {
          ...current,
          snapshots: undefined,
          mode,
          backup_token: token,
          expires_at: String(grant!.expires_at),
          reauth_required: !session.recent_auth,
        };
      });
    },
    async execute(
      actor: string,
      sessionToken: string | undefined,
      mode: DeletionMode,
      input: unknown,
      ledgerId?: unknown,
    ) {
      enabled(mode);
      const started = Date.now(),
        data = valid(resetInputSchema, input);
      return db.begin(async (sql) => {
        const session = await deletionSession(sql, actor, sessionToken, true);
        await assertDeletionSchema(sql);
        const ids =
          mode === 'purge'
            ? [valid(idSchema, ledgerId)]
            : await ownerLedgers(sql, actor);
        const current = await scope(sql, actor, ids, mode, session.sessionHash);
        if (!session.recent_auth) throw new DomainError('reauth_required', 403);
        const [limited] =
          await sql`SELECT 1 FROM audit_logs WHERE user_id=${actor} AND outcome='success' AND action IN ('ledger.purge','account.factory_reset') AND created_at>clock_timestamp()-interval '10 minutes' LIMIT 1`;
        if (limited) throw new DomainError('reset_rate_limited', 429);
        const grant = await grantFor(
          sql,
          actor,
          session.sessionHash,
          data.backup_token,
        );
        if (
          grant.mode !== mode ||
          JSON.stringify([...grant.ledger_ids].sort()) !==
            JSON.stringify([...ids].sort())
        )
          throw new DomainError('backup_token_invalid', 403);
        if (
          data.confirmation !==
          (mode === 'factory' ? 'RESET' : current.ledgers[0]!.name)
        )
          throw new DomainError('confirmation_mismatch', 400);
        if (
          Object.keys(grant.counts).length !==
            Object.keys(current.counts).length ||
          Object.entries(current.counts).some(
            ([k, v]) => grant.counts[k] !== v,
          ) ||
          Object.keys(grant.snapshots).length !==
            Object.keys(current.snapshots).length ||
          Object.entries(current.snapshots).some(
            ([k, v]) => grant.snapshots[k] !== v,
          )
        )
          throw new DomainError('preview_changed', 409);
        if (ids.some((id) => !/^[a-f0-9]{64}$/.test(grant.backups[id] ?? '')))
          throw new DomainError('backup_required', 409);
        // Locks and snapshot hashing can take time: never use transaction-start
        // now() or an earlier cached freshness result for destructive authorization.
        if (!(await deletionSession(sql, actor, sessionToken)).recent_auth)
          throw new DomainError('reauth_required', 403);
        await grantFor(sql, actor, session.sessionHash, data.backup_token);
        // Delete only the exact previewed ledgers. A concurrently created ledger
        // must never be swept into an unbacked, broader owner-based DELETE.
        if (ids.length)
          for (const table of deletionLedgerTables)
            await sql`DELETE FROM ${sql(table)} WHERE ledger_id IN ${sql(ids)}`;
        if (ids.length)
          await sql`DELETE FROM ledgers WHERE id IN ${sql(ids)} AND owner_id=${actor}`;
        if (mode === 'factory') {
          await sql`DELETE FROM personal_access_tokens WHERE user_id=${actor}`;
          await sql`DELETE FROM sessions WHERE user_id=${actor} AND token_hash<>${session.sessionHash}`;
        }
        await sql`DELETE FROM data_reset_grants WHERE user_id=${actor}`;
        const duration = Math.min(
          2147483647,
          Math.max(0, Date.now() - started),
        );
        await sql`INSERT INTO audit_logs(user_id,action,outcome,deleted_counts,duration_ms,created_at)
          VALUES (${actor},${mode === 'factory' ? 'account.factory_reset' : 'ledger.purge'},'success',${sql.json(current.counts)},${duration},clock_timestamp())`;
        return { success: true, counts: current.counts };
      });
    },
  };
}
