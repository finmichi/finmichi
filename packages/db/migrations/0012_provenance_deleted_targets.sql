-- Preserve provenance when targets were already deleted. Malformed legacy keys are
-- left intact so strict backup validation can report them instead of hiding them.
UPDATE import_source_records r SET target_id='deleted:'||r.target_id
WHERE r.target_id NOT LIKE 'deleted:%' AND (
 (r.target_table IN ('items','payees','projects','transactions')
  AND r.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT (
   (r.target_table='items' AND EXISTS(SELECT 1 FROM items i WHERE i.ledger_id=r.ledger_id AND i.id::text=lower(r.target_id))) OR
   (r.target_table='payees' AND EXISTS(SELECT 1 FROM payees i WHERE i.ledger_id=r.ledger_id AND i.id::text=lower(r.target_id))) OR
   (r.target_table='projects' AND EXISTS(SELECT 1 FROM projects i WHERE i.ledger_id=r.ledger_id AND i.id::text=lower(r.target_id))) OR
   (r.target_table='transactions' AND EXISTS(SELECT 1 FROM transactions i WHERE i.ledger_id=r.ledger_id AND i.id::text=lower(r.target_id)))
  )) OR
 (r.target_table='exchange_rates' AND r.target_id ~ '^\d{4}-\d{2}-\d{2}\|[A-Z]{3}\|[A-Z]{3}$'
  AND NOT EXISTS(SELECT 1 FROM exchange_rates e WHERE e.ledger_id=r.ledger_id AND e.rate_date::text||'|'||e.from_currency||'|'||e.to_currency=r.target_id))
);
