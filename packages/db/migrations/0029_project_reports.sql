-- SPDX-License-Identifier: AGPL-3.0-only
-- Additive read-only reports; existing functions and stored accounting data are unchanged.
CREATE VIEW report_project_entry_facts AS
 SELECT l.owner_id,e.ledger_id,t.occurred_on,e.item_id,i.kind,i.parent_id,
        i.non_operating,i.fixed,e.currency,e.amount,e.base_amount,
        CASE WHEN i.kind IN ('liability','income','equity') THEN -e.base_amount ELSE e.base_amount END AS natural_amount,t.project_id
 FROM transaction_entries e JOIN transactions t ON (t.id,t.ledger_id)=(e.transaction_id,e.ledger_id)
 JOIN items i ON (i.id,i.ledger_id)=(e.item_id,e.ledger_id)
 JOIN ledgers l ON l.id=e.ledger_id;


-- Bound calendar buckets before generate_series allocates any rows.
CREATE FUNCTION report_income_summary_project(p_owner uuid,p_ledger uuid,p_from date,p_to date,p_grain text,p_project uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE periods integer;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM ledgers WHERE id=p_ledger AND owner_id=p_owner AND (p_project IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id=p_project AND ledger_id=p_ledger)))
    OR p_from IS NULL OR p_to IS NULL OR p_from>p_to
    OR p_grain IS NULL OR p_grain NOT IN ('day','month','quarter','year') THEN
  RETURN NULL;
 END IF;
 periods := CASE p_grain
  WHEN 'day' THEN p_to-p_from+1
  WHEN 'month' THEN (extract(year FROM p_to)-extract(year FROM p_from))::integer*12
    +extract(month FROM p_to)::integer-extract(month FROM p_from)::integer+1
  WHEN 'quarter' THEN (extract(year FROM p_to)-extract(year FROM p_from))::integer*4
    +(extract(month FROM p_to)::integer-1)/3-(extract(month FROM p_from)::integer-1)/3+1
  WHEN 'year' THEN extract(year FROM p_to)::integer-extract(year FROM p_from)::integer+1
 END;
 IF periods>1000 THEN
  RAISE EXCEPTION 'period_range_too_large' USING ERRCODE='P0001';
 END IF;
 RETURN (
WITH owned AS (
  SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner AND (p_project IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id=p_project AND ledger_id=p_ledger)) AND p_from<=p_to AND p_grain IN ('day','month','quarter','year')
 ), parameters AS (
  SELECT CASE p_grain WHEN 'day' THEN interval '1 day' WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months' WHEN 'year' THEN interval '1 year' END AS step FROM owned
 ), periods AS (
  SELECT anchor::date AS bucket_start,greatest(anchor::date,p_from) AS date_from,least((anchor+step)::date-1,p_to) AS date_to,
   to_char(anchor,CASE p_grain WHEN 'day' THEN 'YYYY-MM-DD' WHEN 'month' THEN 'YYYY-MM' WHEN 'quarter' THEN 'YYYY-"Q"Q' WHEN 'year' THEN 'YYYY' END) AS label
  FROM parameters CROSS JOIN LATERAL generate_series(date_trunc(p_grain,p_from::timestamp),date_trunc(p_grain,p_to::timestamp),step) AS anchor
 ), amounts AS (
  SELECT date_trunc(p_grain,occurred_on::timestamp)::date AS bucket_start,
   sum(natural_amount) FILTER(WHERE kind='income' AND NOT non_operating) AS oi,
   sum(natural_amount) FILTER(WHERE kind='income' AND non_operating) AS ni,
   sum(natural_amount) FILTER(WHERE kind='expense' AND NOT non_operating) AS oe,
   sum(natural_amount) FILTER(WHERE kind='expense' AND non_operating) AS ne
  FROM report_project_entry_facts WHERE owner_id=p_owner AND (p_project IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id=p_project AND ledger_id=p_ledger)) AND ledger_id=p_ledger AND occurred_on BETWEEN p_from AND p_to AND kind IN ('income','expense') AND (p_project IS NULL OR project_id=p_project)
  GROUP BY date_trunc(p_grain,occurred_on::timestamp)::date
 ), buckets AS (
  SELECT p.*,coalesce(a.oi,0) AS oi,coalesce(a.ni,0) AS ni,coalesce(a.oe,0) AS oe,coalesce(a.ne,0) AS ne
  FROM periods p LEFT JOIN amounts a USING(bucket_start)
 )
 SELECT jsonb_build_object('report','income-summary','ledger_id',o.id,'base_currency',o.base_currency,'generated_at',transaction_timestamp(),
  'date_from',p_from::text,'date_to',p_to::text,'grain',p_grain,
  'periods',coalesce((SELECT jsonb_agg(jsonb_build_object('bucket_start',bucket_start::text,'date_from',date_from::text,'date_to',date_to::text,'label',label)||report_income_values(oi,ni,oe,ne) ORDER BY bucket_start) FROM buckets),'[]'::jsonb),
  'totals',(SELECT report_income_values(coalesce(sum(oi),0),coalesce(sum(ni),0),coalesce(sum(oe),0),coalesce(sum(ne),0)) FROM buckets)
 ) FROM owned o
 );
END;
$$;

CREATE FUNCTION report_category_statistics_project(p_owner uuid,p_ledger uuid,p_from date,p_to date,p_kind text,p_non_op text,p_fixed text,p_project uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH RECURSIVE owned AS (
  SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner AND (p_project IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id=p_project AND ledger_id=p_ledger)) AND p_from<=p_to AND p_kind IN ('income','expense')
   AND p_non_op IN ('all','operating','non_operating') AND p_fixed IN ('all','fixed','variable')
 ), nodes AS (
  SELECT i.* FROM items i JOIN owned o ON o.id=i.ledger_id WHERE i.kind=p_kind
 ), facts AS MATERIALIZED (
  SELECT * FROM report_project_entry_facts f WHERE f.owner_id=p_owner AND (p_project IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id=p_project AND ledger_id=p_ledger)) AND f.ledger_id=p_ledger AND f.kind=p_kind AND f.occurred_on BETWEEN p_from AND p_to AND (p_project IS NULL OR f.project_id=p_project)
   AND (p_non_op='all' OR (p_non_op='operating' AND NOT f.non_operating) OR (p_non_op='non_operating' AND f.non_operating))
   AND (p_fixed='all' OR (p_fixed='fixed' AND f.fixed) OR (p_fixed='variable' AND NOT f.fixed))
 ), own AS (
  SELECT item_id,sum(natural_amount) AS amount FROM facts GROUP BY item_id
 ), closure(ancestor,descendant) AS (
  SELECT id,id FROM nodes UNION ALL SELECT c.ancestor,n.id FROM closure c JOIN nodes n ON n.parent_id=c.descendant
 ), sums AS (
  SELECT c.ancestor,sum(a.amount) AS amount FROM closure c JOIN own a ON a.item_id=c.descendant GROUP BY c.ancestor
 ), rolled AS (
  SELECT n.*,coalesce(a.amount,0) AS own_amount,coalesce(s.amount,0) AS rollup_amount,
   NOT EXISTS(SELECT 1 FROM nodes c WHERE c.parent_id=n.id) AS is_leaf
  FROM nodes n LEFT JOIN own a ON a.item_id=n.id LEFT JOIN sums s ON s.ancestor=n.id
 ), visible_ids(id) AS (
  SELECT id FROM rolled WHERE rollup_amount<>0
  UNION SELECT n.parent_id FROM nodes n JOIN visible_ids v ON v.id=n.id WHERE n.parent_id IS NOT NULL
 ), shown AS (
  SELECT r.* FROM rolled r JOIN visible_ids v USING(id)
 ), total AS (
  SELECT coalesce(sum(amount),0) AS amount FROM own
 ), objects AS (
  SELECT s.*,jsonb_build_object('id',s.id,'parent_id',s.parent_id,'name',s.name,'kind',s.kind,'non_operating',s.non_operating,'fixed',s.fixed,'archived',s.archived,'is_leaf',s.is_leaf,
   'own_amount',round(s.own_amount,2)::text,'rollup_amount',round(s.rollup_amount,2)::text,'percentage',report_percentage(s.rollup_amount,t.amount)::text) AS data
  FROM shown s CROSS JOIN total t
 ), root_stats AS (
  SELECT count(*) AS n,coalesce(sum(rollup_amount),0) AS amount,sum(report_percentage(rollup_amount,t.amount)) AS percentage_sum
  FROM objects CROSS JOIN total t WHERE parent_id IS NULL
 ), leaf_max AS (
  SELECT coalesce(max(abs(rollup_amount)),0) AS amount FROM objects WHERE is_leaf
 ), top_leaves AS (
  SELECT * FROM objects WHERE is_leaf AND rollup_amount<>0 ORDER BY abs(rollup_amount) DESC,name COLLATE "C",id LIMIT 10
 )
 SELECT jsonb_build_object('report','category-statistics','ledger_id',o.id,'base_currency',o.base_currency,'generated_at',transaction_timestamp(),
  'date_from',p_from::text,'date_to',p_to::text,'kind',p_kind,'non_operating',p_non_op,'fixed',p_fixed,
  'total_amount',round(t.amount,2)::text,'root_amount',round(r.amount,2)::text,'root_count',r.n::text,'root_total_matches',r.amount=t.amount,
  'root_percentage_sum',CASE WHEN t.amount>0 THEN round(r.percentage_sum,10)::text END,
  'percentage_tolerance',round(r.n*0.0000000001,10)::text,
  'percentage_sum_within_tolerance',CASE WHEN t.amount>0 THEN abs(r.percentage_sum-100)<=r.n*0.0000000001 END,
  'pie_available',t.amount>0 AND NOT EXISTS(SELECT 1 FROM objects WHERE rollup_amount<0),
  'pie_reason',CASE WHEN t.amount<0 THEN 'negative_total' WHEN t.amount=0 THEN 'zero_total' WHEN EXISTS(SELECT 1 FROM objects WHERE rollup_amount<0) THEN 'negative_items' END,
  'items',coalesce((SELECT jsonb_agg(data ORDER BY name COLLATE "C",id) FROM objects),'[]'::jsonb),
  'pie',coalesce((SELECT jsonb_agg(data ORDER BY name COLLATE "C",id) FROM objects WHERE parent_id IS NULL),'[]'::jsonb),
  'bars',coalesce((SELECT jsonb_agg(l.data||jsonb_build_object('chart_weight',coalesce(report_percentage(l.rollup_amount,m.amount),0)::text) ORDER BY abs(l.rollup_amount) DESC,l.name COLLATE "C",l.id) FROM top_leaves l CROSS JOIN leaf_max m),'[]'::jsonb)
 ) FROM owned o CROSS JOIN total t CROSS JOIN root_stats r
$$;

CREATE FUNCTION report_projects(p_owner uuid,p_ledger uuid,p_from date,p_to date,p_archived boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH RECURSIVE owned AS (
  SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner AND p_from<=p_to
 ), chosen AS (
  SELECT p.* FROM projects p JOIN owned o ON o.id=p.ledger_id WHERE p_archived OR NOT p.archived
 ), tx AS MATERIALIZED (
  SELECT t.* FROM transactions t JOIN chosen p ON (p.id,p.ledger_id)=(t.project_id,t.ledger_id)
  WHERE t.occurred_on BETWEEN p_from AND p_to
 ), facts AS MATERIALIZED (
  SELECT f.* FROM report_project_entry_facts f JOIN chosen p ON (p.id,p.ledger_id)=(f.project_id,f.ledger_id)
  WHERE f.owner_id=p_owner AND f.ledger_id=p_ledger AND f.occurred_on BETWEEN p_from AND p_to
 ), metrics AS (
  SELECT project_id,coalesce(sum(natural_amount) FILTER(WHERE kind='income'),0) income,
   coalesce(sum(natural_amount) FILTER(WHERE kind='expense'),0) expense FROM facts GROUP BY project_id
 ), dates AS (
  SELECT project_id,count(*) n,min(occurred_on) first_on,max(occurred_on) last_on FROM tx GROUP BY project_id
 ), nodes AS (
  SELECT * FROM items WHERE ledger_id=p_ledger AND kind IN ('income','expense')
 ), closure(ancestor,descendant) AS (
  SELECT id,id FROM nodes UNION ALL SELECT c.ancestor,n.id FROM closure c JOIN nodes n ON n.parent_id=c.descendant
 ), direct AS (
  SELECT project_id,item_id,sum(natural_amount) amount,count(*) n FROM facts WHERE kind IN ('income','expense') GROUP BY project_id,item_id
 ), rolled AS (
  SELECT d.project_id,c.ancestor,sum(d.amount) amount,sum(d.n) n FROM direct d JOIN closure c ON c.descendant=d.item_id GROUP BY d.project_id,c.ancestor
 ), tree AS (
  SELECT s.project_id,jsonb_agg(jsonb_build_object('id',i.id,'parent_id',i.parent_id,'name',i.name,'kind',i.kind,
   'own_amount',round(coalesce(d.amount,0),2)::text,'rollup_amount',round(s.amount,2)::text) ORDER BY i.kind,i.name COLLATE "C",i.id) data
  FROM rolled s JOIN nodes i ON i.id=s.ancestor LEFT JOIN direct d ON (d.project_id,d.item_id)=(s.project_id,i.id) GROUP BY s.project_id
 ), currencies AS (
  SELECT project_id,currency,sum(amount) original_amount,sum(base_amount) base_amount
  FROM facts WHERE kind='expense' GROUP BY project_id,currency
 ), months AS (
  SELECT project_id,to_char(occurred_on,'YYYY-MM') AS month,
   coalesce(sum(natural_amount) FILTER(WHERE kind='income'),0) income,
   coalesce(sum(natural_amount) FILTER(WHERE kind='expense'),0) expense FROM facts GROUP BY project_id,to_char(occurred_on,'YYYY-MM')
 ), rows AS (
  SELECT p.id,p.name,jsonb_build_object('id',p.id,'name',p.name,'archived',p.archived,
   'income',round(coalesce(m.income,0),2)::text,'expense',round(coalesce(m.expense,0),2)::text,
   'net',round(coalesce(m.income,0)-coalesce(m.expense,0),2)::text,'transaction_count',coalesce(d.n,0),
   'first_on',d.first_on::text,'last_on',d.last_on::text,'days',coalesce(d.last_on-d.first_on+1,0),
   'daily_average_expense',round(coalesce(m.expense,0)/nullif(d.last_on-d.first_on+1,0),2)::text,
   'items',coalesce(t.data,'[]'::jsonb),
   'currencies',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',c.currency,'original_expense',c.original_amount::text,'base_expense',round(c.base_amount,2)::text) ORDER BY c.currency) FROM currencies c WHERE c.project_id=p.id),'[]'::jsonb),
   'months',coalesce((SELECT jsonb_agg(jsonb_build_object('month',x.month,'income',round(x.income,2)::text,'expense',round(x.expense,2)::text,'net',round(x.income-x.expense,2)::text) ORDER BY x.month) FROM months x WHERE x.project_id=p.id),'[]'::jsonb)
  ) data FROM chosen p LEFT JOIN metrics m ON m.project_id=p.id LEFT JOIN dates d ON d.project_id=p.id LEFT JOIN tree t ON t.project_id=p.id
 )
 SELECT jsonb_build_object('report','projects','ledger_id',o.id,'base_currency',o.base_currency,'generated_at',transaction_timestamp(),
  'date_from',p_from::text,'date_to',p_to::text,'include_archived',p_archived,
  'projects',coalesce((SELECT jsonb_agg(data ORDER BY name COLLATE "C",id) FROM rows),'[]'::jsonb)) FROM owned o
$$;
