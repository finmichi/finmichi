-- ADR0012 rev1.10; settings never create entries; zero postings are durable decisions.
CREATE TABLE fixed_deposits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledgers(id),
 item_id uuid NOT NULL,bank text NOT NULL CHECK(length(bank) BETWEEN 1 AND 200),principal numeric(20,2) NOT NULL CHECK(principal>0 AND principal<'Infinity'::numeric),annual_rate numeric(9,6) NOT NULL CHECK(annual_rate BETWEEN 0 AND 100),
 start_on date NOT NULL,maturity_on date NOT NULL CHECK(maturity_on>start_on),interest_basis text NOT NULL CHECK(interest_basis IN ('monthly','daily')),payout text NOT NULL CHECK(payout IN ('at_maturity','monthly')),auto_renew boolean NOT NULL DEFAULT false,
 payout_account_id uuid NOT NULL,interest_item_id uuid NOT NULL,note text NOT NULL DEFAULT '' CHECK(length(note)<=2000),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','matured','closed')),renewed_from_id uuid,
 UNIQUE(id,ledger_id),CHECK(renewed_from_id IS DISTINCT FROM id),
 FOREIGN KEY(item_id,ledger_id) REFERENCES items(id,ledger_id),FOREIGN KEY(payout_account_id,ledger_id) REFERENCES items(id,ledger_id),FOREIGN KEY(interest_item_id,ledger_id) REFERENCES items(id,ledger_id),FOREIGN KEY(renewed_from_id,ledger_id) REFERENCES fixed_deposits(id,ledger_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE deposit_postings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL,deposit_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('interest','settlement')),period_no integer,
 posted_on date NOT NULL,gross_interest numeric(20,2) NOT NULL CHECK(gross_interest>=0 AND gross_interest<'Infinity'::numeric),withholding_tax numeric(20,2) NOT NULL CHECK(withholding_tax>=0 AND withholding_tax<'Infinity'::numeric),nhi_premium numeric(20,2) NOT NULL CHECK(nhi_premium>=0 AND nhi_premium<'Infinity'::numeric),
 renew text NOT NULL CHECK(renew IN ('none','principal','principal_and_interest')),renewed_deposit_id uuid,transaction_id uuid UNIQUE,
 CHECK(withholding_tax+nhi_premium<=gross_interest),CHECK((kind='interest' AND period_no IS NOT NULL AND period_no>0 AND renew='none' AND renewed_deposit_id IS NULL) OR (kind='settlement' AND period_no IS NULL)),
 CHECK((renew='none')=(renewed_deposit_id IS NULL)),
 CHECK((transaction_id IS NULL)=(gross_interest=0 AND withholding_tax=0 AND nhi_premium=0 AND NOT(kind='settlement' AND renew='none'))),
 UNIQUE(id,ledger_id),FOREIGN KEY(deposit_id,ledger_id) REFERENCES fixed_deposits(id,ledger_id),FOREIGN KEY(renewed_deposit_id,ledger_id) REFERENCES fixed_deposits(id,ledger_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(transaction_id,ledger_id) REFERENCES transactions(id,ledger_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX deposit_interest_period ON deposit_postings(deposit_id,period_no) WHERE kind='interest';
CREATE UNIQUE INDEX deposit_settlement_once ON deposit_postings(deposit_id) WHERE kind='settlement';
CREATE INDEX deposits_maturity ON fixed_deposits(ledger_id,status,maturity_on);
CREATE FUNCTION check_deposit_settings() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE d fixed_deposits; n integer; BEGIN
 FOR d IN SELECT * FROM fixed_deposits WHERE (TG_TABLE_NAME='fixed_deposits' AND id=coalesce(NEW.id,OLD.id)) OR (TG_TABLE_NAME='items' AND (item_id=NEW.id OR payout_account_id=NEW.id OR interest_item_id=NEW.id)) LOOP
 IF NOT EXISTS(SELECT 1 FROM items i JOIN items p ON p.id=d.payout_account_id JOIN items inc ON inc.id=d.interest_item_id JOIN ledgers l ON l.id=d.ledger_id WHERE i.id=d.item_id AND i.kind='asset' AND NOT i.securities AND NOT i.credit_card AND NOT i.loan AND p.kind='asset' AND NOT p.securities AND i.currency=p.currency AND inc.kind='income' AND inc.currency=l.base_currency) THEN RAISE EXCEPTION 'invalid deposit accounts' USING ERRCODE='23514';END IF;
 IF d.interest_basis='monthly' THEN n:=(extract(year FROM d.maturity_on)::integer-extract(year FROM d.start_on)::integer)*12+extract(month FROM d.maturity_on)::integer-extract(month FROM d.start_on)::integer;
 IF n<1 OR (d.start_on+make_interval(months=>n))::date<>d.maturity_on THEN RAISE EXCEPTION 'deposit_term_invalid' USING ERRCODE='23514';END IF;END IF;
 END LOOP;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER deposit_settings_integrity AFTER INSERT OR UPDATE ON fixed_deposits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_deposit_settings();
CREATE CONSTRAINT TRIGGER deposit_item_integrity AFTER UPDATE ON items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_deposit_settings();
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK(action IN ('login','logout','ledger.create','ledger.update','ledger.lock','ledger.unlock','ledger.delete','item.create','item.update','payees.create','payees.update','payees.delete','projects.create','projects.update','projects.delete','memo_templates.create','memo_templates.update','memo_templates.delete','transaction.create','transaction.update','transaction.delete','life2023.import','emoney.import','backup.restore','backup.download','pat.create','pat.revoke','mcp.call','market.fx_upload','draft.create','draft.approve','draft.reject','draft.expire','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete','card.update','card.delete','loan.update','loan.delete','security.create','security.update','security.delete','security.price_update','security.price_delete','security.trade_create','security.trade_update','security.trade_delete','security.recalculate','dividend.create','dividend.update','dividend.delete','income_code.create','income_code.update','income_code.delete','income_code.initialize','deposit.create','deposit.update','deposit.delete','deposit.interest','deposit.settle','deposit.revoke'));
