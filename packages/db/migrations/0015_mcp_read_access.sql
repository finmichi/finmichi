ALTER TABLE personal_access_tokens ADD COLUMN request_window_at timestamptz;
ALTER TABLE personal_access_tokens ADD COLUMN request_count integer NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 60);
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK (action IN (


 'login','logout','ledger.create','ledger.update','ledger.delete',
 'item.create','item.update','payees.create','payees.update','payees.delete',
 'projects.create','projects.update','projects.delete',
 'memo_templates.create','memo_templates.update','memo_templates.delete',
 'transaction.create','transaction.update','transaction.delete',
 'life2023.import','emoney.import','backup.restore','backup.download'
, 'pat.create','pat.revoke'
, 'mcp.call'
));
ALTER TABLE audit_logs ADD COLUMN tool text CHECK (tool IN ('list_ledgers','list_items','search_transactions','get_balance','get_report'));
ALTER TABLE audit_logs ADD COLUMN token_prefix text CHECK (token_prefix ~ '^llp_[A-Za-z0-9_-]{4}$');
ALTER TABLE audit_logs ADD CONSTRAINT audit_mcp_metadata CHECK (
 (action='mcp.call' AND token_prefix IS NOT NULL) OR (action<>'mcp.call' AND tool IS NULL AND token_prefix IS NULL)
);
