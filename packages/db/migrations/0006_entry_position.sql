-- Preserve entry input order: ADR-0002 uses it as the final rounding tie-break.
ALTER TABLE transaction_entries ADD COLUMN entry_position integer;
WITH positions AS (
 SELECT id, row_number() OVER (PARTITION BY transaction_id ORDER BY id) - 1 AS position
 FROM transaction_entries
)
UPDATE transaction_entries e SET entry_position=p.position FROM positions p WHERE p.id=e.id;
ALTER TABLE transaction_entries ALTER COLUMN entry_position SET NOT NULL;
ALTER TABLE transaction_entries ADD CONSTRAINT entry_position_nonnegative CHECK(entry_position >= 0);
ALTER TABLE transaction_entries ADD CONSTRAINT entry_position_unique UNIQUE(transaction_id,entry_position);
-- Existing SQL clients may omit the position. The existing entry-write trigger
-- locks the parent transaction; use an explicit parent lock here as well.
CREATE FUNCTION assign_entry_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id AND NEW.entry_position=OLD.entry_position THEN
   NEW.entry_position := NULL;
  END IF;
 END IF;
 IF NEW.entry_position IS NULL THEN
  PERFORM 1 FROM transactions WHERE id=NEW.transaction_id FOR UPDATE;
  SELECT coalesce(max(entry_position)+1,0) INTO NEW.entry_position
   FROM transaction_entries WHERE transaction_id=NEW.transaction_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entry_position_default BEFORE INSERT OR UPDATE OF transaction_id ON transaction_entries
 FOR EACH ROW EXECUTE FUNCTION assign_entry_position();
