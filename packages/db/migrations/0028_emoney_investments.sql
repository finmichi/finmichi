-- ADR-0012 rev.1.12: imported investment history never owns journal entries.
ALTER TABLE security_trades ADD COLUMN origin text NOT NULL DEFAULT 'app' CHECK(origin IN('app','emoney'));
ALTER TABLE security_trades ADD COLUMN source_transaction_id uuid;
ALTER TABLE security_trades ADD CONSTRAINT security_source_transaction FOREIGN KEY(source_transaction_id,ledger_id) REFERENCES transactions(id,ledger_id) ON DELETE SET NULL (source_transaction_id);
-- Replace only the original transaction-shape checks, retaining every other invariant.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='security_trades'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%transaction_id%' LOOP
 EXECUTE format('ALTER TABLE security_trades DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE security_trades ADD CONSTRAINT security_origin_transaction CHECK(origin<>'emoney' OR transaction_id IS NULL);
ALTER TABLE security_trades ADD CONSTRAINT security_app_transaction CHECK(origin<>'app' OR trade_type NOT IN('buy','sell') OR transaction_id IS NOT NULL);
ALTER TABLE security_trades ADD CONSTRAINT security_dividend_transaction CHECK(trade_type<>'stock_dividend' OR transaction_id IS NULL);
ALTER TABLE security_trades ADD CONSTRAINT security_adjust_transaction CHECK(trade_type<>'adjust' OR (cost_mode='keep' AND quantity_after>0 AND cost_after IS NULL AND cash_amount IS NULL AND transaction_id IS NULL) OR (cost_mode='set_cost' AND cost_after IS NOT NULL AND cash_amount IS NULL) OR (cost_mode='cash_return' AND cash_amount IS NOT NULL AND cost_after IS NULL AND (origin='emoney' OR transaction_id IS NOT NULL)));
ALTER TABLE import_jobs ADD COLUMN kind text NOT NULL DEFAULT 'ledger' CHECK(kind IN('ledger','emoney-investments'));
DROP INDEX imported_source_sha_idx;
CREATE UNIQUE INDEX imported_source_sha_idx ON import_jobs(ledger_id,source_sha256,kind) WHERE status='imported';
ALTER TABLE import_source_records DROP CONSTRAINT import_source_records_target_table_check;
ALTER TABLE import_source_records ADD CONSTRAINT import_source_records_target_table_check CHECK(target_table IN('items','payees','projects','exchange_rates','transactions','securities','security_trades','fixed_deposits'));
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK(action IN ('login','logout','ledger.create','ledger.update','ledger.lock','ledger.unlock','ledger.delete','item.create','item.update','payees.create','payees.update','payees.delete','projects.create','projects.update','projects.delete','memo_templates.create','memo_templates.update','memo_templates.delete','transaction.create','transaction.update','transaction.delete','life2023.import','emoney.import','emoney.import_investments','backup.restore','backup.download','pat.create','pat.revoke','mcp.call','market.fx_upload','draft.create','draft.approve','draft.reject','draft.expire','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete','card.update','card.delete','loan.update','loan.delete','security.create','security.update','security.delete','security.price_update','security.price_delete','security.trade_create','security.trade_update','security.trade_delete','security.recalculate','dividend.create','dividend.update','dividend.delete','income_code.create','income_code.update','income_code.delete','income_code.initialize','deposit.create','deposit.update','deposit.delete','deposit.interest','deposit.settle','deposit.revoke','reminder.settings_update'));

-- ADR rev.1.14: imported history cannot become an adjustment.
ALTER TABLE security_trades ADD CONSTRAINT security_emoney_type CHECK(origin<>'emoney' OR trade_type IN('buy','sell','stock_dividend'));
