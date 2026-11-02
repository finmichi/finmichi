CREATE TABLE credit_card_settings (
 item_id uuid PRIMARY KEY, ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 statement_day integer NOT NULL CHECK(statement_day BETWEEN 1 AND 31),due_day integer NOT NULL CHECK(due_day BETWEEN 1 AND 31),due_month_offset integer NOT NULL CHECK(due_month_offset IN(0,1)),
 payment_account_id uuid,credit_limit numeric(20,2) CHECK(credit_limit>=0),
 CHECK(due_month_offset=1 OR(statement_day<=27 AND due_day>statement_day)),
 FOREIGN KEY(item_id,ledger_id) REFERENCES items(id,ledger_id) ON DELETE CASCADE,
 FOREIGN KEY(payment_account_id,ledger_id) REFERENCES items(id,ledger_id)
);
CREATE TABLE loan_settings (
 item_id uuid PRIMARY KEY,ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 principal numeric(20,2) NOT NULL CHECK(principal>=0.01),annual_rate numeric(9,6) NOT NULL CHECK(annual_rate BETWEEN 0 AND 100),term_months integer NOT NULL CHECK(term_months BETWEEN 1 AND 600),first_payment_on date NOT NULL,
 method text NOT NULL CHECK(method IN('annuity','equal_principal')),payment_account_id uuid NOT NULL,interest_item_id uuid NOT NULL,
 FOREIGN KEY(item_id,ledger_id) REFERENCES items(id,ledger_id) ON DELETE CASCADE,
 FOREIGN KEY(payment_account_id,ledger_id) REFERENCES items(id,ledger_id),
 FOREIGN KEY(interest_item_id,ledger_id) REFERENCES items(id,ledger_id)
);
CREATE FUNCTION enforce_finance_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM items i JOIN ledgers l ON l.id=i.ledger_id WHERE i.id IN(NEW.item_id,NEW.payment_account_id) AND i.currency<>l.base_currency) THEN RAISE EXCEPTION 'currency_not_supported' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='loan_settings' THEN IF EXISTS(SELECT 1 FROM items i JOIN ledgers l ON l.id=i.ledger_id WHERE i.id=NEW.interest_item_id AND i.currency<>l.base_currency) THEN RAISE EXCEPTION 'currency_not_supported' USING ERRCODE='23514';END IF;END IF;
 IF NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.item_id AND ledger_id=NEW.ledger_id AND kind='liability' AND CASE TG_TABLE_NAME WHEN 'credit_card_settings' THEN credit_card ELSE loan END) THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;
 IF NEW.payment_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.payment_account_id AND ledger_id=NEW.ledger_id AND kind='asset') THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='loan_settings' THEN
 IF NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.interest_item_id AND ledger_id=NEW.ledger_id AND kind='expense') THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER card_settings_kind BEFORE INSERT OR UPDATE ON credit_card_settings FOR EACH ROW EXECUTE FUNCTION enforce_finance_settings();
CREATE TRIGGER loan_settings_kind BEFORE INSERT OR UPDATE ON loan_settings FOR EACH ROW EXECUTE FUNCTION enforce_finance_settings();
CREATE FUNCTION preserve_finance_item_kind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.currency<>(SELECT base_currency FROM ledgers WHERE id=NEW.ledger_id) AND (EXISTS(SELECT 1 FROM credit_card_settings WHERE item_id=NEW.id OR payment_account_id=NEW.id) OR EXISTS(SELECT 1 FROM loan_settings WHERE item_id=NEW.id OR payment_account_id=NEW.id OR interest_item_id=NEW.id)) THEN RAISE EXCEPTION 'currency_not_supported' USING ERRCODE='23514';END IF;

 IF EXISTS(SELECT 1 FROM credit_card_settings WHERE item_id=NEW.id) AND (NEW.kind<>'liability' OR NOT NEW.credit_card) OR EXISTS(SELECT 1 FROM loan_settings WHERE item_id=NEW.id) AND (NEW.kind<>'liability' OR NOT NEW.loan) OR NEW.kind<>'asset' AND (EXISTS(SELECT 1 FROM credit_card_settings WHERE payment_account_id=NEW.id) OR EXISTS(SELECT 1 FROM loan_settings WHERE payment_account_id=NEW.id)) OR NEW.kind<>'expense' AND EXISTS(SELECT 1 FROM loan_settings WHERE interest_item_id=NEW.id) THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_finance_kind BEFORE UPDATE OF kind,credit_card,loan,currency ON items FOR EACH ROW EXECUTE FUNCTION preserve_finance_item_kind();
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK(action IN (
'login','logout','ledger.create','ledger.update','ledger.lock','ledger.unlock','ledger.delete','item.create','item.update','payees.create','payees.update','payees.delete','projects.create','projects.update','projects.delete','memo_templates.create','memo_templates.update','memo_templates.delete','transaction.create','transaction.update','transaction.delete','life2023.import','emoney.import','backup.restore','backup.download','pat.create','pat.revoke','mcp.call','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete','card.update','card.delete','loan.update','loan.delete'));
