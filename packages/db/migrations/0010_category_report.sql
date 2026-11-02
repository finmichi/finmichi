-- Exact rational HALF_UP at 10 decimal places. div avoids intermediate division rounding.
CREATE FUNCTION report_percentage(p_amount numeric,p_total numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER AS $$
 SELECT CASE WHEN p_total>0 THEN round(sign(p_amount)*div(2*abs(p_amount)*1000000000000+p_total,2*p_total)*0.0000000001,10) END
$$;
CREATE FUNCTION report_category_statistics(p_owner uuid,p_ledger uuid,p_from date,p_to date,p_kind text,p_non_op text,p_fixed text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH RECURSIVE owned AS (
  SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner AND p_from<=p_to AND p_kind IN ('income','expense')
   AND p_non_op IN ('all','operating','non_operating') AND p_fixed IN ('all','fixed','variable')
 ), nodes AS (
  SELECT i.* FROM items i JOIN owned o ON o.id=i.ledger_id WHERE i.kind=p_kind
 ), facts AS MATERIALIZED (
  SELECT * FROM report_entry_facts f WHERE f.owner_id=p_owner AND f.ledger_id=p_ledger AND f.kind=p_kind AND f.occurred_on BETWEEN p_from AND p_to
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
