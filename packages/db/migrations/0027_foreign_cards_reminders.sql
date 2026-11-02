CREATE OR REPLACE FUNCTION enforce_finance_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='credit_card_settings' THEN
 IF EXISTS(SELECT 1 FROM items card JOIN ledgers l ON l.id=card.ledger_id JOIN items p ON p.id=NEW.payment_account_id AND p.ledger_id=card.ledger_id WHERE card.id=NEW.item_id AND p.currency NOT IN(l.base_currency,card.currency)) THEN RAISE EXCEPTION 'currency_not_supported' USING ERRCODE='23514';END IF;
 ELSE
 IF EXISTS(SELECT 1 FROM items i JOIN ledgers l ON l.id=i.ledger_id WHERE i.id IN(NEW.item_id,NEW.payment_account_id,NEW.interest_item_id) AND i.currency<>l.base_currency) THEN RAISE EXCEPTION 'currency_not_supported' USING ERRCODE='23514';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.item_id AND ledger_id=NEW.ledger_id AND kind='liability' AND CASE TG_TABLE_NAME WHEN 'credit_card_settings' THEN credit_card ELSE loan END) THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;
 IF NEW.payment_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.payment_account_id AND ledger_id=NEW.ledger_id AND kind='asset') THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='loan_settings' THEN
 IF NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.interest_item_id AND ledger_id=NEW.ledger_id AND kind='expense') THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION preserve_finance_item_kind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM loan_settings WHERE item_id=NEW.id OR payment_account_id=NEW.id OR interest_item_id=NEW.id) AND NEW.currency<>(SELECT base_currency FROM ledgers WHERE id=NEW.ledger_id) THEN RAISE EXCEPTION 'currency_not_supported' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM credit_card_settings s JOIN items c ON c.id=s.item_id JOIN items p ON p.id=s.payment_account_id JOIN ledgers l ON l.id=s.ledger_id WHERE (s.item_id=NEW.id OR s.payment_account_id=NEW.id) AND (CASE WHEN p.id=NEW.id THEN NEW.currency ELSE p.currency END) NOT IN(l.base_currency,CASE WHEN c.id=NEW.id THEN NEW.currency ELSE c.currency END)) THEN RAISE EXCEPTION 'currency_not_supported' USING ERRCODE='23514';END IF;


 IF EXISTS(SELECT 1 FROM credit_card_settings WHERE item_id=NEW.id) AND (NEW.kind<>'liability' OR NOT NEW.credit_card) OR EXISTS(SELECT 1 FROM loan_settings WHERE item_id=NEW.id) AND (NEW.kind<>'liability' OR NOT NEW.loan) OR NEW.kind<>'asset' AND (EXISTS(SELECT 1 FROM credit_card_settings WHERE payment_account_id=NEW.id) OR EXISTS(SELECT 1 FROM loan_settings WHERE payment_account_id=NEW.id)) OR NEW.kind<>'expense' AND EXISTS(SELECT 1 FROM loan_settings WHERE interest_item_id=NEW.id) THEN RAISE EXCEPTION 'finance_item_kind_invalid' USING ERRCODE='23514';END IF;RETURN NEW;END $$;

CREATE TABLE reminder_settings (ledger_id uuid PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
deposit_enabled boolean NOT NULL DEFAULT true,deposit_days integer NOT NULL DEFAULT 7 CHECK(deposit_days BETWEEN 0 AND 60),
card_enabled boolean NOT NULL DEFAULT true,card_days integer NOT NULL DEFAULT 7 CHECK(card_days BETWEEN 0 AND 60),
loan_enabled boolean NOT NULL DEFAULT true,loan_days integer NOT NULL DEFAULT 3 CHECK(loan_days BETWEEN 0 AND 60),
recurring_enabled boolean NOT NULL DEFAULT true,recurring_days integer NOT NULL DEFAULT 0 CHECK(recurring_days BETWEEN 0 AND 60),
draft_enabled boolean NOT NULL DEFAULT true,draft_days integer NOT NULL DEFAULT 0 CHECK(draft_days BETWEEN 0 AND 60),
market_enabled boolean NOT NULL DEFAULT true,market_trading_days integer NOT NULL DEFAULT 3 CHECK(market_trading_days BETWEEN 1 AND 20));
CREATE TABLE reminder_reads (ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,key text NOT NULL CHECK(length(key)<=120),fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(ledger_id,key));
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK(action IN ('login','logout','ledger.create','ledger.update','ledger.lock','ledger.unlock','ledger.delete','item.create','item.update','payees.create','payees.update','payees.delete','projects.create','projects.update','projects.delete','memo_templates.create','memo_templates.update','memo_templates.delete','transaction.create','transaction.update','transaction.delete','life2023.import','emoney.import','backup.restore','backup.download','pat.create','pat.revoke','mcp.call','market.fx_upload','draft.create','draft.approve','draft.reject','draft.expire','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete','card.update','card.delete','loan.update','loan.delete','security.create','security.update','security.delete','security.price_update','security.price_delete','security.trade_create','security.trade_update','security.trade_delete','security.recalculate','dividend.create','dividend.update','dividend.delete','income_code.create','income_code.update','income_code.delete','income_code.initialize','deposit.create','deposit.update','deposit.delete','deposit.interest','deposit.settle','deposit.revoke','reminder.settings_update'));
