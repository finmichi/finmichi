-- ADR-0012 rev1.6: TWD securities, stable replay order and exact position snapshots.
ALTER TABLE items ADD COLUMN securities boolean NOT NULL DEFAULT false;
CREATE TABLE securities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledgers(id),
 symbol text NOT NULL CHECK(symbol ~ '^[A-Z0-9]{4,6}$'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 market text NOT NULL CHECK(market IN('TWSE','TPEx')),kind text NOT NULL CHECK(kind IN('stock','etf')),
 item_id uuid NOT NULL,archived boolean NOT NULL DEFAULT false,
 UNIQUE(id,ledger_id),UNIQUE(ledger_id,market,symbol,item_id),FOREIGN KEY(item_id,ledger_id) REFERENCES items(id,ledger_id)
);
CREATE TABLE security_trades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledgers(id),security_id uuid NOT NULL,
 transaction_id uuid UNIQUE,trade_type text NOT NULL CHECK(trade_type IN('buy','sell','stock_dividend','adjust')),
 trade_date date NOT NULL,sequence integer NOT NULL CHECK(sequence>0),
 quantity numeric CHECK(quantity>0 AND quantity=trunc(quantity)),quantity_after numeric CHECK(quantity_after>=0 AND quantity_after=trunc(quantity_after)),
 price numeric(20,6) NOT NULL DEFAULT 0 CHECK(price>=0),fee numeric(20,2) NOT NULL DEFAULT 0 CHECK(fee>=0),tax numeric(20,2) NOT NULL DEFAULT 0 CHECK(tax>=0),
 cost_mode text CHECK(cost_mode IN('keep','set_cost','cash_return')),cost_after numeric CHECK(cost_after>=0 AND cost_after=round(cost_after,2)),
 cash_amount numeric(20,2) CHECK(cash_amount>0),note text NOT NULL DEFAULT '' CHECK(length(note)<=2000),
 settlement_item_id uuid,expense_item_id uuid,gain_item_id uuid,
 gross numeric NOT NULL CHECK(gross>=0 AND gross=round(gross,2)),cost_removed numeric NOT NULL CHECK(cost_removed>=0 AND cost_removed=round(cost_removed,2)),
 position_quantity numeric NOT NULL CHECK(position_quantity>=0 AND position_quantity=trunc(position_quantity)),
 position_cost numeric NOT NULL CHECK(position_cost>=0 AND position_cost=round(position_cost,2)),realized_gain numeric NOT NULL CHECK(realized_gain=round(realized_gain,2)),
 CHECK(position_quantity<>0 OR position_cost=0),
 CHECK((trade_type='adjust' AND quantity IS NULL AND quantity_after IS NOT NULL AND cost_mode IS NOT NULL) OR (trade_type<>'adjust' AND quantity IS NOT NULL AND quantity_after IS NULL AND cost_mode IS NULL AND cost_after IS NULL AND cash_amount IS NULL)),
 CHECK(trade_type NOT IN('buy','sell') OR transaction_id IS NOT NULL),
 CHECK(trade_type<>'stock_dividend' OR transaction_id IS NULL),
 CHECK(trade_type<>'adjust' OR (cost_mode='keep' AND quantity_after>0 AND cost_after IS NULL AND cash_amount IS NULL AND transaction_id IS NULL) OR (cost_mode='set_cost' AND cost_after IS NOT NULL AND cash_amount IS NULL) OR (cost_mode='cash_return' AND cash_amount IS NOT NULL AND cost_after IS NULL AND transaction_id IS NOT NULL)),
 UNIQUE(security_id,trade_date,sequence) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(security_id,ledger_id) REFERENCES securities(id,ledger_id),
 FOREIGN KEY(transaction_id,ledger_id) REFERENCES transactions(id,ledger_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(settlement_item_id,ledger_id) REFERENCES items(id,ledger_id),
 FOREIGN KEY(expense_item_id,ledger_id) REFERENCES items(id,ledger_id),FOREIGN KEY(gain_item_id,ledger_id) REFERENCES items(id,ledger_id)
);
CREATE INDEX security_trade_history ON security_trades(security_id,trade_date DESC,sequence DESC);
CREATE TABLE manual_prices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ledger_id uuid NOT NULL REFERENCES ledgers(id),market text NOT NULL CHECK(market IN('TWSE','TPEx')),
 symbol text NOT NULL CHECK(symbol ~ '^[A-Z0-9]{4,6}$'),price_date date NOT NULL,price numeric(20,6) NOT NULL CHECK(price>=0),
 UNIQUE(ledger_id,market,symbol,price_date)
);
CREATE FUNCTION enforce_security_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (SELECT base_currency FROM ledgers WHERE id=NEW.ledger_id)<>'TWD' THEN RAISE EXCEPTION 'securities_require_twd_ledger' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='securities' THEN
  IF NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.item_id AND ledger_id=NEW.ledger_id AND kind='asset' AND currency='TWD' AND securities) THEN RAISE EXCEPTION 'security_item_invalid' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='security_trades' THEN
  IF NEW.settlement_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.settlement_item_id AND ledger_id=NEW.ledger_id AND kind='asset' AND currency='TWD' AND NOT securities) THEN RAISE EXCEPTION 'security_account_invalid' USING ERRCODE='23514';END IF;
  IF NEW.expense_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.expense_item_id AND ledger_id=NEW.ledger_id AND kind='expense' AND currency='TWD' AND non_operating) THEN RAISE EXCEPTION 'security_account_invalid' USING ERRCODE='23514';END IF;
  IF NEW.gain_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.gain_item_id AND ledger_id=NEW.ledger_id AND kind='income' AND currency='TWD' AND non_operating) THEN RAISE EXCEPTION 'security_account_invalid' USING ERRCODE='23514';END IF;
  IF NEW.transaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM transactions WHERE id=NEW.transaction_id AND ledger_id=NEW.ledger_id AND occurred_on=NEW.trade_date) THEN RAISE EXCEPTION 'security_transaction_invalid' USING ERRCODE='23514';END IF;
 END IF; RETURN NEW;END $$;
CREATE TRIGGER security_record BEFORE INSERT OR UPDATE ON securities FOR EACH ROW EXECUTE FUNCTION enforce_security_record();
CREATE TRIGGER security_trade_record BEFORE INSERT OR UPDATE ON security_trades FOR EACH ROW EXECUTE FUNCTION enforce_security_record();
CREATE TRIGGER security_price_record BEFORE INSERT OR UPDATE ON manual_prices FOR EACH ROW EXECUTE FUNCTION enforce_security_record();
CREATE FUNCTION enforce_security_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.securities AND ((SELECT base_currency FROM ledgers WHERE id=NEW.ledger_id)<>'TWD' OR NEW.currency<>'TWD' OR NEW.kind<>'asset') THEN RAISE EXCEPTION 'security_item_invalid' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM securities WHERE item_id=NEW.id) AND (NOT NEW.securities OR NEW.kind<>'asset' OR NEW.currency<>'TWD') THEN RAISE EXCEPTION 'security_item_in_use' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM security_trades WHERE expense_item_id=NEW.id) AND (NEW.kind<>'expense' OR NEW.currency<>'TWD' OR NOT NEW.non_operating) OR EXISTS(SELECT 1 FROM security_trades WHERE gain_item_id=NEW.id) AND (NEW.kind<>'income' OR NEW.currency<>'TWD' OR NOT NEW.non_operating) OR EXISTS(SELECT 1 FROM security_trades WHERE settlement_item_id=NEW.id) AND (NEW.kind<>'asset' OR NEW.currency<>'TWD' OR NEW.securities) THEN RAISE EXCEPTION 'security_account_in_use' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER security_item BEFORE INSERT OR UPDATE OF securities,kind,currency,non_operating ON items FOR EACH ROW EXECUTE FUNCTION enforce_security_item();
CREATE FUNCTION preserve_security_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.base_currency<>'TWD' AND EXISTS(SELECT 1 FROM items WHERE ledger_id=NEW.id AND securities) THEN RAISE EXCEPTION 'securities_require_twd_ledger' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER security_ledger BEFORE UPDATE OF base_currency ON ledgers FOR EACH ROW EXECUTE FUNCTION preserve_security_ledger();
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK(action IN ('login','logout','ledger.create','ledger.update','ledger.lock','ledger.unlock','ledger.delete','item.create','item.update','payees.create','payees.update','payees.delete','projects.create','projects.update','projects.delete','memo_templates.create','memo_templates.update','memo_templates.delete','transaction.create','transaction.update','transaction.delete','life2023.import','emoney.import','backup.restore','backup.download','pat.create','pat.revoke','mcp.call','market.fx_upload','draft.create','draft.approve','draft.reject','draft.expire','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete','card.update','card.delete','loan.update','loan.delete','security.create','security.update','security.delete','security.price_update','security.price_delete','security.trade_create','security.trade_update','security.trade_delete','security.recalculate'));
