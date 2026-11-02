-- SPDX-License-Identifier: AGPL-3.0-only
-- Existing sessions must explicitly reauthenticate before destructive actions.
ALTER TABLE sessions ADD COLUMN authenticated_at timestamptz;
ALTER TABLE sessions ADD COLUMN reauthenticated boolean NOT NULL DEFAULT false;
CREATE TABLE data_reset_grants (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 mode text NOT NULL CHECK (mode IN ('purge','factory')),
 ledger_ids uuid[] NOT NULL,
 snapshots jsonb NOT NULL CHECK (jsonb_typeof(snapshots)='object'),
 counts jsonb NOT NULL CHECK (jsonb_typeof(counts)='object'),
 backups jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(backups)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 CHECK (expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
 CHECK (mode<>'purge' OR cardinality(ledger_ids)=1)
);
ALTER TABLE audit_logs ADD COLUMN deleted_counts jsonb;
ALTER TABLE audit_logs ADD COLUMN duration_ms integer CHECK (duration_ms>=0);
CREATE FUNCTION audit_deletion_counts_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN jsonb_typeof(value)<>'object' THEN false ELSE NOT EXISTS (
  SELECT 1 FROM jsonb_each(value) AS e(k,v)
  WHERE k !~ '^[a-z_]{1,80}$' OR jsonb_typeof(v)<>'number' OR v::text !~ '^[0-9]{1,15}$'
 ) END
$$;
ALTER TABLE audit_logs ADD CONSTRAINT audit_deletion_metadata_valid CHECK (
 (deleted_counts IS NULL AND duration_ms IS NULL) OR
 (action IN ('ledger.purge','account.factory_reset') AND deleted_counts IS NOT NULL
  AND audit_deletion_counts_valid(deleted_counts) AND duration_ms IS NOT NULL)
);
ALTER TABLE audit_logs ADD CONSTRAINT audit_deletion_metadata_required CHECK (
 action NOT IN ('ledger.purge','account.factory_reset') OR outcome<>'success'
 OR (deleted_counts IS NOT NULL AND duration_ms IS NOT NULL)
);
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK (action IN (
 'login',
 'logout',
 'ledger.create',
 'ledger.update',
 'ledger.lock',
 'ledger.unlock',
 'ledger.delete',
 'ledger.purge',
 'account.factory_reset',
 'item.create',
 'item.update',
 'payees.create',
 'payees.update',
 'payees.delete',
 'projects.create',
 'projects.update',
 'projects.delete',
 'memo_templates.create',
 'memo_templates.update',
 'memo_templates.delete',
 'transaction.create',
 'transaction.update',
 'transaction.delete',
 'life2023.import',
 'emoney.import',
 'emoney.import_investments',
 'backup.restore',
 'backup.download',
 'pat.create',
 'pat.revoke',
 'mcp.call',
 'market.fx_upload',
 'draft.create',
 'draft.approve',
 'draft.reject',
 'draft.expire',
 'recurring.create',
 'recurring.update',
 'recurring.delete',
 'recurring.generate',
 'recurring.post',
 'recurring.skip',
 'budget.update',
 'budget.delete',
 'card.update',
 'card.delete',
 'loan.update',
 'loan.delete',
 'security.create',
 'security.update',
 'security.delete',
 'security.price_update',
 'security.price_delete',
 'security.trade_create',
 'security.trade_update',
 'security.trade_delete',
 'security.recalculate',
 'dividend.create',
 'dividend.update',
 'dividend.delete',
 'income_code.create',
 'income_code.update',
 'income_code.delete',
 'income_code.initialize',
 'reminder.settings_update',
 'deposit.create',
 'deposit.update',
 'deposit.delete',
 'deposit.interest',
 'deposit.settle',
 'deposit.revoke'
));
