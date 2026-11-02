CREATE TABLE transaction_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 token_id uuid REFERENCES personal_access_tokens(id) ON DELETE SET NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 preview jsonb NOT NULL CHECK(jsonb_typeof(preview)='object'),
 note text NOT NULL DEFAULT '' CHECK(char_length(note)<=500),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
 created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,transaction_id uuid,
 FOREIGN KEY(transaction_id,ledger_id) REFERENCES transactions(id,ledger_id) ON DELETE SET NULL(transaction_id),
 CHECK((status='pending')=(decided_at IS NULL))
);
CREATE INDEX drafts_ledger_page ON transaction_drafts(ledger_id,created_at DESC,id DESC);
CREATE INDEX drafts_token_page ON transaction_drafts(token_id,created_at DESC,id DESC);
CREATE INDEX drafts_expiry ON transaction_drafts(created_at) WHERE status='pending';
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK(action IN ('login','logout','ledger.create','ledger.update','ledger.lock','ledger.unlock','ledger.delete','item.create','item.update','payees.create','payees.update','payees.delete','projects.create','projects.update','projects.delete','memo_templates.create','memo_templates.update','memo_templates.delete','transaction.create','transaction.update','transaction.delete','life2023.import','emoney.import','backup.restore','backup.download','pat.create','pat.revoke','mcp.call','draft.create','draft.approve','draft.reject','draft.expire','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete','card.update','card.delete','loan.update','loan.delete'));
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_tool_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_tool_check CHECK(tool IN ('list_ledgers','list_items','search_transactions','get_balance','get_report','draft_transaction','suggest_item','list_drafts'));
