CREATE INDEX audit_logs_owner_cursor_idx ON audit_logs(user_id, created_at DESC, id DESC);
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK (action IN (
 'login','logout','ledger.create','ledger.update','ledger.delete',
 'item.create','item.update','payees.create','payees.update','payees.delete',
 'projects.create','projects.update','projects.delete',
 'memo_templates.create','memo_templates.update','memo_templates.delete',
 'transaction.create','transaction.update','transaction.delete',
 'life2023.import','emoney.import','backup.restore','backup.download'
));
