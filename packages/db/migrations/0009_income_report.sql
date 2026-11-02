CREATE FUNCTION report_income_values(oi numeric,ni numeric,oe numeric,ne numeric)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('operating_income',round(oi,2)::text,'non_operating_income',round(ni,2)::text,
  'operating_expense',round(oe,2)::text,'non_operating_expense',round(ne,2)::text,
  'income_total',round(oi+ni,2)::text,'expense_total',round(oe+ne,2)::text,'net_income',round(oi+ni-oe-ne,2)::text)
$$;
CREATE FUNCTION report_income_summary(p_owner uuid,p_ledger uuid,p_from date,p_to date,p_grain text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH owned AS (
  SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner AND p_from<=p_to AND p_grain IN ('day','month','quarter','year')
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
  FROM report_entry_facts WHERE owner_id=p_owner AND ledger_id=p_ledger AND occurred_on BETWEEN p_from AND p_to AND kind IN ('income','expense')
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
$$;
