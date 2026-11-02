-- ADR-0010 P2-1: only extend audit actions; existing ledger date storage is unchanged.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK (action IN (


 'login','logout','ledger.create','ledger.update','ledger.delete','ledger.lock','ledger.unlock',
 'item.create','item.update','payees.create','payees.update','payees.delete',
 'projects.create','projects.update','projects.delete',
 'memo_templates.create','memo_templates.update','memo_templates.delete',
 'transaction.create','transaction.update','transaction.delete',
 'life2023.import','emoney.import','backup.restore','backup.download'
, 'pat.create','pat.revoke'
, 'mcp.call'
));
