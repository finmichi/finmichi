-- ADR-0011: read-only, owner-scoped historical book reports. No monetary float.
CREATE FUNCTION report_profit_loss(p_owner uuid,p_ledger uuid,p_from date,p_to date,p_grain text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ledgers WHERE id=p_ledger AND owner_id=p_owner) THEN RETURN NULL; END IF;
 IF p_from>p_to OR p_to >= (p_from + interval '10 years')::date
    OR p_grain NOT IN ('month','quarter','year') THEN
  RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';
 END IF;
 WITH RECURSIVE buckets AS (
  SELECT x.value->>'bucket_start' AS bucket_start,x.value->>'label' AS label
  FROM jsonb_array_elements(report_income_summary(p_owner,p_ledger,p_from,p_to,p_grain)->'periods') x
 ), nodes AS (
  SELECT * FROM items WHERE ledger_id=p_ledger AND kind IN ('income','expense')
 ), closure(ancestor,descendant) AS (
  SELECT id,id FROM nodes UNION ALL SELECT c.ancestor,n.id FROM closure c JOIN nodes n ON n.parent_id=c.descendant
 ), facts AS MATERIALIZED (
  SELECT *,date_trunc(p_grain,occurred_on::timestamp)::date::text AS bucket_start,
   CASE WHEN non_operating THEN 'non_operating_' ELSE 'operating_' END||kind AS section
  FROM report_entry_facts WHERE owner_id=p_owner AND ledger_id=p_ledger
   AND occurred_on BETWEEN p_from AND p_to AND kind IN ('income','expense')
 ), amounts AS (
  SELECT c.ancestor,f.section,f.bucket_start,sum(f.natural_amount) amount
  FROM closure c JOIN facts f ON f.item_id=c.descendant GROUP BY c.ancestor,f.section,f.bucket_start
 ), visible AS (
  -- Keep nonzero own activity and every ancestor even when siblings cancel.
  SELECT DISTINCT c.ancestor id,f.section FROM closure c JOIN (
   SELECT item_id,section,bucket_start FROM facts GROUP BY item_id,section,bucket_start HAVING sum(natural_amount)<>0
  ) f ON f.item_id=c.descendant
 ), item_rows AS (
  SELECT v.section,n.id,n.parent_id,n.name,
   (SELECT jsonb_agg(round(coalesce(a.amount,0),2)::text ORDER BY b.bucket_start)
    FROM buckets b LEFT JOIN amounts a ON a.ancestor=n.id AND a.section=v.section AND a.bucket_start=b.bucket_start) AS amounts,
   round(coalesce((SELECT sum(a.amount) FROM amounts a WHERE a.ancestor=n.id AND a.section=v.section),0),2)::text AS total
  FROM visible v JOIN nodes n ON n.id=v.id
 ), raw AS (
  SELECT b.*,coalesce(sum(f.natural_amount) FILTER(WHERE section='operating_income'),0) oi,
   coalesce(sum(f.natural_amount) FILTER(WHERE section='non_operating_income'),0) ni,
   coalesce(sum(f.natural_amount) FILTER(WHERE section='operating_expense'),0) oe,
   coalesce(sum(f.natural_amount) FILTER(WHERE section='non_operating_expense'),0) ne,
   coalesce(sum(f.natural_amount) FILTER(WHERE section='operating_expense' AND fixed),0) fe,
   coalesce(sum(f.natural_amount) FILTER(WHERE section='operating_expense' AND NOT fixed),0) ve
  FROM buckets b LEFT JOIN facts f USING(bucket_start) GROUP BY b.bucket_start,b.label
 ), totals AS (
  SELECT *,false grand FROM raw UNION ALL
  SELECT NULL,'合計',sum(oi),sum(ni),sum(oe),sum(ne),sum(fe),sum(ve),true FROM raw
 ), objects AS (
  SELECT *,report_income_values(oi,ni,oe,ne)||jsonb_build_object('bucket_start',bucket_start,'label',label,
   'operating_profit',round(oi-oe,2)::text,'non_operating_profit',round(ni-ne,2)::text,
   'fixed_expense',round(fe,2)::text,'variable_expense',round(ve,2)::text,
   'operating_margin',CASE WHEN oi<>0 THEN round(sign((oi-oe)*oi)*div(2*abs(oi-oe)*1000000000000+abs(oi),2*abs(oi))*0.0000000001,10)::text END) AS data
  FROM totals
 )
 SELECT jsonb_build_object('report','profit-loss','ledger_id',l.id,'base_currency',l.base_currency,'generated_at',transaction_timestamp(),
  'date_from',p_from::text,'date_to',p_to::text,'grain',p_grain,
  'periods',(SELECT jsonb_agg(data ORDER BY bucket_start) FROM objects WHERE NOT grand),
  'totals',(SELECT data FROM objects WHERE grand),
  'sections',(SELECT jsonb_agg(jsonb_build_object('key',s.key,'items',coalesce((
   SELECT jsonb_agg(to_jsonb(r)-'section' ORDER BY name COLLATE "C",id) FROM item_rows r WHERE section=s.key),'[]'::jsonb)) ORDER BY s.pos)
   FROM (VALUES(1,'operating_income'),(2,'operating_expense'),(3,'non_operating_income'),(4,'non_operating_expense')) s(pos,key))
 ) INTO result FROM ledgers l WHERE id=p_ledger AND owner_id=p_owner;
 RETURN result;
END $$;

CREATE FUNCTION report_net_worth_flow(p_owner uuid,p_ledger uuid,p_from date,p_to date,p_grain text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH owned AS (SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner),
 buckets AS (
  SELECT value->>'bucket_start' bucket_start,value->>'label' label,(value->>'date_from')::date date_from,(value->>'date_to')::date date_to
  FROM jsonb_array_elements(report_income_summary(p_owner,p_ledger,p_from,p_to,p_grain)->'periods')
 ), facts AS MATERIALIZED (
  SELECT * FROM report_entry_facts WHERE owner_id=p_owner AND ledger_id=p_ledger AND occurred_on<=p_to
 ), opening AS (
  SELECT coalesce(sum(base_amount) FILTER(WHERE kind IN ('asset','liability')),0) amount FROM facts WHERE occurred_on<p_from
 ), movements AS (
  SELECT b.*,coalesce(sum(f.natural_amount) FILTER(WHERE kind='income'),0) income,
   coalesce(sum(f.natural_amount) FILTER(WHERE kind='expense'),0) expense,
   coalesce(sum(f.natural_amount) FILTER(WHERE kind='equity'),0) equity,
   coalesce(sum(f.base_amount) FILTER(WHERE kind IN ('asset','liability')),0) net
  FROM buckets b LEFT JOIN facts f ON f.occurred_on BETWEEN b.date_from AND b.date_to GROUP BY b.bucket_start,b.label,b.date_from,b.date_to
 ), balances AS (
  SELECT *,o.amount+coalesce(sum(net) OVER(ORDER BY bucket_start ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) opening,
   o.amount+sum(net) OVER(ORDER BY bucket_start ROWS UNBOUNDED PRECEDING) closing FROM movements CROSS JOIN opening o
 )
 SELECT jsonb_build_object('report','net-worth-flow','ledger_id',o.id,'base_currency',o.base_currency,'generated_at',transaction_timestamp(),
 'date_from',p_from::text,'date_to',p_to::text,'grain',p_grain,
 'periods',coalesce((SELECT jsonb_agg(jsonb_build_object('bucket_start',bucket_start,'label',label,'date_from',date_from::text,'date_to',date_to::text,
  'opening',round(opening,2)::text,'income',round(income,2)::text,'expense',round(expense,2)::text,'equity_change',round(equity,2)::text,'closing',round(closing,2)::text,
  'is_balanced',opening+income-expense+equity=closing,'identity_difference',round(opening+income-expense+equity-closing,2)::text) ORDER BY bucket_start) FROM balances),'[]'::jsonb)
 ) FROM owned o
$$;

CREATE FUNCTION report_account_ledger(p_owner uuid,p_ledger uuid,p_item uuid,p_from date,p_to date,p_limit integer,p_after jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH RECURSIVE owned AS (
  SELECT l.id,l.base_currency,i.kind FROM ledgers l JOIN items i ON i.ledger_id=l.id
  WHERE l.owner_id=p_owner AND l.id=p_ledger AND i.id=p_item AND i.kind IN ('asset','liability') AND p_from<=p_to AND p_limit BETWEEN 1 AND 500
 ), subtree AS (
  SELECT i.id FROM items i JOIN owned o ON o.id=i.ledger_id WHERE i.id=p_item
  UNION ALL SELECT i.id FROM items i JOIN subtree s ON i.parent_id=s.id WHERE i.ledger_id=p_ledger
 ), facts AS MATERIALIZED (
  SELECT e.id entry_id,e.transaction_id,e.entry_position,t.occurred_on,t.created_at,t.memo,i.name item_name,e.item_id,e.currency,e.exchange_rate,
   CASE WHEN o.kind='liability' THEN -e.amount ELSE e.amount END amount,
   CASE WHEN o.kind='liability' THEN -e.base_amount ELSE e.base_amount END base,
   CASE WHEN (SELECT count(*) FROM transaction_entries other WHERE other.transaction_id=t.id)=2 THEN
    (SELECT oi.name FROM transaction_entries other JOIN items oi ON oi.id=other.item_id WHERE other.transaction_id=t.id AND other.id<>e.id)
    ELSE '多筆分錄' END counterpart
  FROM transaction_entries e JOIN subtree s ON s.id=e.item_id JOIN transactions t ON t.id=e.transaction_id AND t.ledger_id=e.ledger_id
  JOIN items i ON i.id=e.item_id CROSS JOIN owned o WHERE e.ledger_id=p_ledger AND t.occurred_on<=p_to
 ), running AS (
  SELECT *,sum(amount) OVER w original_balance,sum(base) OVER w book_balance
  FROM facts WINDOW w AS(PARTITION BY currency ORDER BY occurred_on,created_at,transaction_id,entry_position,entry_id ROWS UNBOUNDED PRECEDING)
 ), filtered AS (
  SELECT * FROM running WHERE occurred_on>=p_from
 ), after_cursor AS (
  SELECT * FROM filtered WHERE p_after IS NULL OR (occurred_on,created_at,transaction_id,entry_position,entry_id)>
  ((p_after->>'occurred_on')::date,(p_after->>'created_at')::timestamptz,(p_after->>'transaction_id')::uuid,(p_after->>'entry_position')::integer,(p_after->>'entry_id')::uuid)
 ), page AS (
  SELECT * FROM after_cursor ORDER BY occurred_on,created_at,transaction_id,entry_position,entry_id LIMIT p_limit
 ), currencies AS (
  SELECT DISTINCT i.currency FROM items i JOIN subtree s ON i.id=s.id
 ), balances AS (
  SELECT c.currency,
   coalesce(sum(f.amount) FILTER(WHERE occurred_on<p_from),0) opening_original,
   coalesce(sum(f.base) FILTER(WHERE occurred_on<p_from),0) opening_book,
   coalesce(sum(f.amount),0) closing_original,coalesce(sum(f.base),0) closing_book,
   coalesce(sum(f.amount) FILTER(WHERE occurred_on<p_from OR (occurred_on>=p_from AND
    (occurred_on,created_at,transaction_id,entry_position,entry_id)<=
    (SELECT occurred_on,created_at,transaction_id,entry_position,entry_id FROM page ORDER BY occurred_on DESC,created_at DESC,transaction_id DESC,entry_position DESC,entry_id DESC LIMIT 1)) OR
    (NOT EXISTS(SELECT 1 FROM page) AND p_after IS NOT NULL AND (occurred_on,created_at,transaction_id,entry_position,entry_id)<=
     ((p_after->>'occurred_on')::date,(p_after->>'created_at')::timestamptz,(p_after->>'transaction_id')::uuid,(p_after->>'entry_position')::integer,(p_after->>'entry_id')::uuid))),0) carry_original,
   coalesce(sum(f.base) FILTER(WHERE occurred_on<p_from OR (occurred_on>=p_from AND
    (occurred_on,created_at,transaction_id,entry_position,entry_id)<=
    (SELECT occurred_on,created_at,transaction_id,entry_position,entry_id FROM page ORDER BY occurred_on DESC,created_at DESC,transaction_id DESC,entry_position DESC,entry_id DESC LIMIT 1)) OR
    (NOT EXISTS(SELECT 1 FROM page) AND p_after IS NOT NULL AND (occurred_on,created_at,transaction_id,entry_position,entry_id)<=
     ((p_after->>'occurred_on')::date,(p_after->>'created_at')::timestamptz,(p_after->>'transaction_id')::uuid,(p_after->>'entry_position')::integer,(p_after->>'entry_id')::uuid))),0) carry_book
  FROM currencies c LEFT JOIN facts f USING(currency) GROUP BY c.currency
 )
 SELECT jsonb_build_object('report','account-ledger','ledger_id',o.id,'base_currency',o.base_currency,'generated_at',transaction_timestamp(),
 'item_id',p_item,'date_from',p_from::text,'date_to',p_to::text,
 'balances',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',currency,'opening_original',round(opening_original,6)::text,'opening_book',round(opening_book,2)::text,
 'closing_original',round(closing_original,6)::text,'closing_book',round(closing_book,2)::text) ORDER BY currency) FROM balances),'[]'::jsonb),
 'carry',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',currency,'original_balance',round(carry_original,6)::text,'book_balance',round(carry_book,2)::text) ORDER BY currency) FROM balances),'[]'::jsonb),
 'items',coalesce((SELECT jsonb_agg(jsonb_build_object('entry_id',entry_id,'transaction_id',transaction_id,'entry_position',entry_position,'created_at',created_at::text,
 'occurred_on',occurred_on::text,'memo',memo,'item_id',item_id,'item_name',item_name,'counterpart',counterpart,'currency',currency,
 'amount',round(amount,6)::text,'exchange_rate',round(exchange_rate,10)::text,'base_amount',round(base,2)::text,
 'inflow',round(greatest(base,0),2)::text,'outflow',round(greatest(-base,0),2)::text,
 'original_balance',round(original_balance,6)::text,'book_balance',round(book_balance,2)::text) ORDER BY occurred_on,created_at,transaction_id,entry_position,entry_id) FROM page),'[]'::jsonb),
 'has_more',(SELECT count(*)>p_limit FROM (SELECT 1 FROM after_cursor LIMIT p_limit+1) x)
 ) FROM owned o
$$;
