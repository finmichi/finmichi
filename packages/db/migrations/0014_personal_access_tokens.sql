CREATE TABLE personal_access_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 token_prefix text NOT NULL CHECK (token_prefix ~ '^llp_[A-Za-z0-9_-]{4}$'),
 scope text NOT NULL DEFAULT 'read' CHECK (scope IN ('read','draft','write')),
 ledger_ids uuid[], mask_text boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 last_used_at timestamptz, revoked_at timestamptz,
 CHECK (expires_at >= created_at + interval '1 day' AND expires_at <= created_at + interval '90 days'),
 CHECK (ledger_ids IS NULL OR cardinality(ledger_ids) > 0)
);
CREATE INDEX personal_access_tokens_owner_idx ON personal_access_tokens(user_id);
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK (action IN (

 'login','logout','ledger.create','ledger.update','ledger.delete',
 'item.create','item.update','payees.create','payees.update','payees.delete',
 'projects.create','projects.update','projects.delete',
 'memo_templates.create','memo_templates.update','memo_templates.delete',
 'transaction.create','transaction.update','transaction.delete',
 'life2023.import','emoney.import','backup.restore','backup.download'
, 'pat.create','pat.revoke'
));
