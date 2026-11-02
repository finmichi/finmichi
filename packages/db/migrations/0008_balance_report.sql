-- ADR-0005: shared owner-scoped entry facts and historical book-value report.
CREATE VIEW report_entry_facts AS
 SELECT l.owner_id,e.ledger_id,t.occurred_on,e.item_id,i.kind,i.parent_id,
        i.non_operating,i.fixed,e.currency,e.amount,e.base_amount,
        CASE WHEN i.kind IN ('liability','income','equity') THEN -e.base_amount ELSE e.base_amount END AS natural_amount
 FROM transaction_entries e JOIN transactions t ON (t.id,t.ledger_id)=(e.transaction_id,e.ledger_id)
 JOIN items i ON (i.id,i.ledger_id)=(e.item_id,e.ledger_id)
 JOIN ledgers l ON l.id=e.ledger_id;

CREATE FUNCTION report_balance_sheet(p_owner uuid,p_ledger uuid,p_as_of date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH RECURSIVE owned AS (
   SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner
 ), nodes AS (
   SELECT i.* FROM items i JOIN owned o ON o.id=i.ledger_id
   WHERE i.kind IN ('asset','liability','equity')
 ), facts AS MATERIALIZED (
   SELECT * FROM report_entry_facts WHERE owner_id=p_owner AND ledger_id=p_ledger AND occurred_on<=p_as_of
 ), closure(ancestor,descendant) AS (
   SELECT id,id FROM nodes UNION ALL
   SELECT c.ancestor,n.id FROM closure c JOIN nodes n ON n.parent_id=c.descendant
 ), own AS (
   SELECT item_id,sum(natural_amount) AS book,sum(amount) AS original FROM facts GROUP BY item_id
 ), rollup AS (
   SELECT c.ancestor,sum(f.natural_amount) AS book FROM closure c JOIN facts f ON f.item_id=c.descendant GROUP BY c.ancestor
 ), native AS (
   SELECT c.ancestor,f.currency,sum(f.amount) AS original,sum(f.natural_amount) AS book
   FROM closure c JOIN facts f ON f.item_id=c.descendant GROUP BY c.ancestor,f.currency
 ), native_json AS (
   SELECT ancestor,jsonb_agg(jsonb_build_object('currency',currency,'original_amount',round(original,6)::text,'book_amount',round(book,2)::text) ORDER BY currency) AS balances
   FROM native GROUP BY ancestor
 ), totals AS (
   SELECT coalesce(sum(natural_amount) FILTER(WHERE kind='asset'),0) AS assets,
          coalesce(sum(natural_amount) FILTER(WHERE kind='liability'),0) AS liabilities,
          coalesce(sum(natural_amount) FILTER(WHERE kind='equity'),0) AS equity,
          coalesce(sum(natural_amount) FILTER(WHERE kind='income'),0)-coalesce(sum(natural_amount) FILTER(WHERE kind='expense'),0) AS net_income
   FROM facts
 )
 SELECT jsonb_build_object(
   'report','balance-sheet','ledger_id',o.id,'base_currency',o.base_currency,'as_of',p_as_of::text,'generated_at',transaction_timestamp(),
   'totals',jsonb_build_object('assets',round(t.assets,2)::text,'liabilities',round(t.liabilities,2)::text,
     'net_worth',round(t.assets-t.liabilities,2)::text,'equity',round(t.equity,2)::text,'net_income',round(t.net_income,2)::text,
     'identity_difference',round(t.assets-t.liabilities-t.equity-t.net_income,2)::text,'is_balanced',t.assets-t.liabilities=t.equity+t.net_income),
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
     'id',n.id,'parent_id',n.parent_id,'name',n.name,'kind',n.kind,'currency',n.currency,'archived',n.archived,
     'credit_card',n.credit_card,'loan',n.loan,
     'own_book_amount',round(coalesce(d.book,0),2)::text,'book_amount',round(coalesce(r.book,0),2)::text,
     'own_original_amount',round(coalesce(d.original,0),6)::text,'original_balances',coalesce(j.balances,'[]'::jsonb)
   ) ORDER BY n.name COLLATE "C",n.id) FROM nodes n LEFT JOIN own d ON d.item_id=n.id LEFT JOIN rollup r ON r.ancestor=n.id LEFT JOIN native_json j ON j.ancestor=n.id),'[]'::jsonb)
 ) FROM owned o CROSS JOIN totals t
$$;
