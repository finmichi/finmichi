CREATE TABLE recurring_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200), template jsonb NOT NULL CHECK(jsonb_typeof(template)='object'),
 frequency text NOT NULL CHECK(frequency IN ('monthly','weekly','yearly')), interval integer NOT NULL CHECK(interval BETWEEN 1 AND 12),
 day_of_month integer CHECK(day_of_month BETWEEN 1 AND 31), weekday integer CHECK(weekday BETWEEN 0 AND 6),
 month integer CHECK(month BETWEEN 1 AND 12), day integer CHECK(day BETWEEN 1 AND 31),
 start_on date NOT NULL, end_on date CHECK(end_on>=start_on), active boolean NOT NULL DEFAULT true, auto_post boolean NOT NULL DEFAULT false, next_on date,
 UNIQUE(id,ledger_id),
 CHECK ((frequency='monthly' AND day_of_month IS NOT NULL AND weekday IS NULL AND month IS NULL AND day IS NULL) OR
 (frequency='weekly' AND weekday IS NOT NULL AND day_of_month IS NULL AND month IS NULL AND day IS NULL) OR
 (frequency='yearly' AND month IS NOT NULL AND day IS NOT NULL AND day_of_month IS NULL AND weekday IS NULL))
);
CREATE UNIQUE INDEX recurring_rule_names ON recurring_rules(ledger_id,lower(name));
CREATE INDEX recurring_rules_due ON recurring_rules(next_on) WHERE active;
CREATE TABLE recurring_occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 rule_id uuid,source_rule_id uuid NOT NULL,rule_name text NOT NULL,occurs_on date NOT NULL,occurred_on date NOT NULL,template jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted','skipped','failed')),
 transaction_id uuid,error_code text,
 FOREIGN KEY(rule_id,ledger_id) REFERENCES recurring_rules(id,ledger_id) ON DELETE SET NULL (rule_id),
 FOREIGN KEY(transaction_id,ledger_id) REFERENCES transactions(id,ledger_id) ON DELETE SET NULL (transaction_id),
 UNIQUE(source_rule_id,occurs_on),
 CHECK((status='failed' AND error_code IS NOT NULL) OR (status<>'failed' AND error_code IS NULL))
);
CREATE INDEX recurring_pending ON recurring_occurrences(ledger_id,occurs_on,id) WHERE status IN ('pending','failed');
CREATE TABLE recurring_worker_runs (
 ledger_id uuid PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,run_date date,
 last_started_at timestamptz,last_finished_at timestamptz,status text NOT NULL CHECK(status IN ('running','success','error')),error_code text
);
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK (action IN (


 'login','logout','ledger.create','ledger.update','ledger.delete','ledger.lock','ledger.unlock',
 'item.create','item.update','payees.create','payees.update','payees.delete',
 'projects.create','projects.update','projects.delete',
 'memo_templates.create','memo_templates.update','memo_templates.delete',
 'transaction.create','transaction.update','transaction.delete',
 'life2023.import','emoney.import','backup.restore','backup.download'
, 'pat.create','pat.revoke'
, 'mcp.call','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip'
));
