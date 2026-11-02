ALTER TABLE transaction_entries ADD CONSTRAINT entries_base_two_decimals CHECK (base_amount=round(base_amount,2));
ALTER TABLE transaction_entries ADD CONSTRAINT entries_base_same_sign CHECK (base_amount<>0 AND sign(base_amount)=sign(amount));
CREATE FUNCTION lock_entry_ledger_money() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- FOR SHARE conflicts with a concurrent base_currency UPDATE (NO KEY UPDATE).
 PERFORM id FROM ledgers WHERE id IN (NEW.ledger_id,OLD.ledger_id) ORDER BY id FOR SHARE;
 RETURN NEW;
END $$;
CREATE TRIGGER entries_money_lock BEFORE INSERT OR UPDATE ON transaction_entries
 FOR EACH ROW EXECUTE FUNCTION lock_entry_ledger_money();
CREATE FUNCTION assert_entry_money() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 ledger_to_check uuid;
 transactions_to_check uuid[];
BEGIN
 IF TG_TABLE_NAME='ledgers' THEN ledger_to_check:=NEW.id;
 ELSIF TG_TABLE_NAME='transactions' THEN transactions_to_check:=ARRAY[NEW.id,OLD.id];
 ELSE transactions_to_check:=ARRAY[NEW.transaction_id,OLD.transaction_id]; END IF;
 IF EXISTS (
  SELECT 1 FROM transaction_entries e JOIN ledgers l ON l.id=e.ledger_id
  WHERE (e.ledger_id=ledger_to_check OR e.transaction_id=ANY(transactions_to_check)) AND (
   (e.currency=l.base_currency AND (e.exchange_rate<>1 OR e.base_amount<>e.amount))
   OR abs(e.base_amount-round(e.amount*e.exchange_rate,2))>0.02+abs(e.amount)*0.0000000001
  )
 ) THEN
  RAISE EXCEPTION 'entry violates ADR-0002 base currency or FX deviation invariant' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_money_validated AFTER INSERT OR UPDATE OR DELETE ON transaction_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_money();
CREATE CONSTRAINT TRIGGER transactions_money_validated AFTER INSERT OR UPDATE ON transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_money();
CREATE CONSTRAINT TRIGGER ledgers_money_validated AFTER UPDATE ON ledgers
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_money();
-- Reject existing inconsistent data; never silently rewrite amounts or rates.
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM transaction_entries e JOIN ledgers l ON l.id=e.ledger_id
  WHERE (e.currency=l.base_currency AND (e.exchange_rate<>1 OR e.base_amount<>e.amount))
   OR abs(e.base_amount-round(e.amount*e.exchange_rate,2))>0.02+abs(e.amount)*0.0000000001
 ) THEN RAISE EXCEPTION 'existing entries violate ADR-0002; migration rolled back'; END IF;
END $$;
