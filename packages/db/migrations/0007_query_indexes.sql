-- Stable keyset order and subtree-entry membership lookups.
CREATE INDEX transactions_query_cursor_idx ON transactions(ledger_id,occurred_on DESC,created_at DESC,id DESC);
CREATE INDEX transaction_entries_query_item_idx ON transaction_entries(ledger_id,item_id,transaction_id);
