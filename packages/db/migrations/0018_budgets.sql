CREATE TABLE budgets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 year integer NOT NULL CHECK(year BETWEEN 1 AND 9999),item_id uuid NOT NULL,month integer NOT NULL CHECK(month BETWEEN 1 AND 12),
 amount numeric(20,2) NOT NULL CHECK(amount>=0),UNIQUE(ledger_id,year,item_id,month),
 FOREIGN KEY(item_id,ledger_id) REFERENCES items(id,ledger_id)
);
CREATE FUNCTION enforce_budget_kind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.item_id AND ledger_id=NEW.ledger_id AND kind IN ('income','expense')) THEN RAISE EXCEPTION 'budget_item_kind_invalid' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER budget_kind BEFORE INSERT OR UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION enforce_budget_kind();
CREATE FUNCTION preserve_budget_item_kind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind NOT IN ('income','expense') AND EXISTS(SELECT 1 FROM budgets WHERE item_id=NEW.id AND ledger_id=NEW.ledger_id) THEN RAISE EXCEPTION 'budget_item_kind_invalid' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER budget_item_kind BEFORE UPDATE OF kind ON items FOR EACH ROW EXECUTE FUNCTION preserve_budget_item_kind();
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK (action IN (


 'login','logout','ledger.create','ledger.update','ledger.delete','ledger.lock','ledger.unlock',
 'item.create','item.update','payees.create','payees.update','payees.delete',
 'projects.create','projects.update','projects.delete',
 'memo_templates.create','memo_templates.update','memo_templates.delete',
 'transaction.create','transaction.update','transaction.delete',
 'life2023.import','emoney.import','backup.restore','backup.download'
, 'pat.create','pat.revoke'
, 'mcp.call','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete'
));

CREATE FUNCTION report_budget_vs_actual(p_owner uuid,p_ledger uuid,p_year integer,p_grain text,p_kind text,p_non_op text,p_fixed text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
WITH RECURSIVE owned AS (
 SELECT id,base_currency FROM ledgers WHERE id=p_ledger AND owner_id=p_owner AND p_year BETWEEN 1 AND 9999 AND p_grain IN ('month','quarter','year') AND p_kind IN ('income','expense') AND p_non_op IN ('all','operating','non_operating') AND p_fixed IN ('all','fixed','variable')
), nodes AS (SELECT i.* FROM items i JOIN owned o ON o.id=i.ledger_id WHERE i.kind=p_kind),
 periods AS (SELECT make_date(p_year,m,1) bucket_start,m AS bucket_month,CASE p_grain WHEN 'month' THEN to_char(make_date(p_year,m,1),'YYYY-MM') WHEN 'quarter' THEN p_year::text||'-Q'||((m-1)/3+1)::text ELSE p_year::text END label FROM generate_series(1,12,CASE p_grain WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 ELSE 12 END) m),
 closure(ancestor,descendant) AS (SELECT id,id FROM nodes UNION ALL SELECT c.ancestor,n.id FROM closure c JOIN nodes n ON n.parent_id=c.descendant),
 eligible AS (SELECT * FROM nodes n WHERE (p_non_op='all' OR (p_non_op='operating' AND NOT n.non_operating) OR (p_non_op='non_operating' AND n.non_operating)) AND (p_fixed='all' OR (p_fixed='fixed' AND n.fixed) OR (p_fixed='variable' AND NOT n.fixed))),
 facts AS MATERIALIZED (SELECT f.* FROM report_entry_facts f JOIN eligible e ON e.id=f.item_id WHERE f.owner_id=p_owner AND f.ledger_id=p_ledger AND extract(year FROM f.occurred_on)=p_year),
 actuals AS (SELECT p.bucket_start,f.item_id,sum(f.natural_amount) amount FROM periods p JOIN facts f ON extract(month FROM f.occurred_on) BETWEEN p.bucket_month AND p.bucket_month+CASE p_grain WHEN 'month' THEN 0 WHEN 'quarter' THEN 2 ELSE 11 END GROUP BY p.bucket_start,f.item_id),
 planned AS (SELECT p.bucket_start,b.item_id,sum(b.amount) amount FROM periods p JOIN budgets b ON b.ledger_id=p_ledger AND b.year=p_year AND b.month BETWEEN p.bucket_month AND p.bucket_month+CASE p_grain WHEN 'month' THEN 0 WHEN 'quarter' THEN 2 ELSE 11 END JOIN eligible e ON e.id=b.item_id GROUP BY p.bucket_start,b.item_id),
 own AS (SELECT p.bucket_start,n.id,coalesce(b.amount,0) budget_own,coalesce(a.amount,0) actual_own FROM periods p CROSS JOIN nodes n LEFT JOIN planned b ON b.item_id=n.id AND b.bucket_start=p.bucket_start LEFT JOIN actuals a ON a.item_id=n.id AND a.bucket_start=p.bucket_start),
 sums AS (SELECT a.bucket_start,c.ancestor,sum(a.budget_own) budget_rollup,sum(a.actual_own) actual_rollup FROM closure c JOIN own a ON a.id=c.descendant GROUP BY a.bucket_start,c.ancestor),
 rolled AS (SELECT a.*,s.budget_rollup,s.actual_rollup FROM own a JOIN sums s ON s.ancestor=a.id AND s.bucket_start=a.bucket_start),
 visible(bucket_start,id) AS (SELECT bucket_start,id FROM rolled WHERE budget_rollup<>0 OR actual_rollup<>0 UNION SELECT v.bucket_start,n.parent_id FROM visible v JOIN nodes n ON n.id=v.id WHERE n.parent_id IS NOT NULL),
 objects AS (SELECT r.bucket_start,n.name,n.id,n.parent_id,jsonb_build_object('id',n.id,'parent_id',n.parent_id,'name',n.name,'kind',n.kind,'non_operating',n.non_operating,'fixed',n.fixed,'archived',n.archived,'budget_own',round(r.budget_own,2)::text,'budget_rollup',round(r.budget_rollup,2)::text,'actual_rollup',round(r.actual_rollup,2)::text,'variance',round(r.actual_rollup-r.budget_rollup,2)::text,'achievement',report_percentage(r.actual_rollup,r.budget_rollup)::text) data FROM rolled r JOIN nodes n USING(id) JOIN visible v ON v.id=r.id AND v.bucket_start=r.bucket_start),
 totals AS (SELECT p.bucket_start,p.label,coalesce(sum(a.budget_own),0) b,coalesce(sum(a.actual_own),0) a FROM periods p LEFT JOIN own a ON a.bucket_start=p.bucket_start GROUP BY p.bucket_start,p.label),
 full_total AS (SELECT coalesce(sum(b),0) b,coalesce(sum(a),0) a FROM totals)
 SELECT jsonb_build_object('report','budget-vs-actual','ledger_id',o.id,'base_currency',o.base_currency,'generated_at',transaction_timestamp(),'year',p_year,'grain',p_grain,'kind',p_kind,'non_operating',p_non_op,'fixed',p_fixed,
 'totals',jsonb_build_object('budget_total',round(f.b,2)::text,'actual_total',round(f.a,2)::text,'variance',round(f.a-f.b,2)::text,'achievement',report_percentage(f.a,f.b)::text),
 'periods',coalesce((SELECT jsonb_agg(jsonb_build_object('bucket_start',t.bucket_start::text,'label',t.label,'budget_total',round(t.b,2)::text,'actual_total',round(t.a,2)::text,'variance',round(t.a-t.b,2)::text,'achievement',report_percentage(t.a,t.b)::text,'items',coalesce((SELECT jsonb_agg(j.data ORDER BY j.name COLLATE "C",j.id) FROM objects j WHERE j.bucket_start=t.bucket_start),'[]'::jsonb)) ORDER BY t.bucket_start) FROM totals t),'[]'::jsonb)) FROM owned o CROSS JOIN full_total f
$$;
