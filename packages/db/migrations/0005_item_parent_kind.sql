-- Prevent a writer from slipping between the preflight and trigger installation.
LOCK TABLE items IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM items c JOIN items p ON p.id=c.parent_id AND p.ledger_id=c.ledger_id
  WHERE c.kind<>p.kind
 ) THEN
  RAISE EXCEPTION 'existing items violate parent_kind_mismatch; migration rolled back'
   USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION assert_item_parent_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Serialize parent kind changes and child inserts/moves under one ledger lock.
 PERFORM id FROM ledgers WHERE id=NEW.ledger_id FOR UPDATE;
 IF EXISTS (
  SELECT 1 FROM items p WHERE p.id=NEW.parent_id AND p.ledger_id=NEW.ledger_id AND p.kind<>NEW.kind
 ) OR EXISTS (
  SELECT 1 FROM items c WHERE c.parent_id=NEW.id AND c.ledger_id=NEW.ledger_id AND c.kind<>NEW.kind
 ) THEN
  RAISE EXCEPTION 'parent_kind_mismatch' USING ERRCODE='23514', CONSTRAINT='items_parent_kind';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER items_kind_consistent BEFORE INSERT OR UPDATE OF parent_id,kind,ledger_id ON items
 FOR EACH ROW EXECUTE FUNCTION assert_item_parent_kind();
