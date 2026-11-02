CREATE TABLE ledgers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL CHECK (length(btrim(name)) > 0),
 base_currency text NOT NULL DEFAULT 'TWD' CHECK (base_currency ~ '^[A-Z]{3}$'),
 locked_until date,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledgers_owner_name_idx ON ledgers(owner_id, lower(name));
CREATE TABLE items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 parent_id uuid,
 kind text NOT NULL CHECK (kind IN ('asset','liability','income','expense','equity')),
 name text NOT NULL CHECK (length(btrim(name)) > 0),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 non_operating boolean NOT NULL DEFAULT false,
 fixed boolean NOT NULL DEFAULT false,
 credit_card boolean NOT NULL DEFAULT false,
 loan boolean NOT NULL DEFAULT false,
 archived boolean NOT NULL DEFAULT false,
 UNIQUE (id,ledger_id),
 UNIQUE (id,ledger_id,currency),
 FOREIGN KEY (parent_id,ledger_id) REFERENCES items(id,ledger_id),
 CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX items_ledger_kind_name_idx ON items(ledger_id,kind,lower(name));
CREATE INDEX items_parent_idx ON items(ledger_id,parent_id);
CREATE FUNCTION prevent_item_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Serialize tree mutations within a ledger to prevent concurrent cyclic moves.
 PERFORM id FROM ledgers WHERE id=NEW.ledger_id FOR UPDATE;
 IF NEW.parent_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors AS (
   SELECT id,parent_id FROM items WHERE id=NEW.parent_id AND ledger_id=NEW.ledger_id
   UNION
   SELECT i.id,i.parent_id FROM items i JOIN ancestors a ON i.id=a.parent_id
  ) SELECT 1 FROM ancestors WHERE id=NEW.id
 ) THEN
  RAISE EXCEPTION 'item hierarchy cycle' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER items_no_cycle BEFORE INSERT OR UPDATE OF parent_id,ledger_id ON items
 FOR EACH ROW EXECUTE FUNCTION prevent_item_cycle();
CREATE TABLE payees (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(btrim(name)) > 0),
 archived boolean NOT NULL DEFAULT false,
 UNIQUE (id,ledger_id)
);
CREATE UNIQUE INDEX payees_name_idx ON payees(ledger_id,lower(name));
CREATE TABLE projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(btrim(name)) > 0),
 archived boolean NOT NULL DEFAULT false,
 UNIQUE (id,ledger_id)
);
CREATE UNIQUE INDEX projects_name_idx ON projects(ledger_id,lower(name));
CREATE TABLE memo_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(btrim(name)) > 0),
 memo text NOT NULL,
 archived boolean NOT NULL DEFAULT false,
 UNIQUE (id,ledger_id)
);
CREATE UNIQUE INDEX memo_templates_name_idx ON memo_templates(ledger_id,lower(name));
CREATE TABLE transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 occurred_on date NOT NULL,
 memo text NOT NULL DEFAULT '',
 payee_id uuid,
 project_id uuid,
 invoice_no text NOT NULL DEFAULT '',
 kind text NOT NULL CHECK (kind IN ('income','expense','transfer','adjustment')),
 source_system text,
 source_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (id,ledger_id),
 FOREIGN KEY (payee_id,ledger_id) REFERENCES payees(id,ledger_id),
 FOREIGN KEY (project_id,ledger_id) REFERENCES projects(id,ledger_id),
 CHECK ((source_system IS NULL)=(source_id IS NULL))
);
CREATE UNIQUE INDEX transactions_source_idx ON transactions(ledger_id,source_system,source_id)
 WHERE source_system IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX transactions_date_idx ON transactions(ledger_id,occurred_on,id);
CREATE TABLE transaction_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL,
 transaction_id uuid NOT NULL,
 item_id uuid NOT NULL,
 amount numeric(20,6) NOT NULL CHECK (amount <> 0 AND amount <> 'NaN'::numeric AND amount NOT IN ('Infinity'::numeric,'-Infinity'::numeric)),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 exchange_rate numeric(24,10) NOT NULL CHECK (exchange_rate > 0 AND exchange_rate <> 'NaN'::numeric AND exchange_rate <> 'Infinity'::numeric),
 base_amount numeric(20,6) NOT NULL CHECK (base_amount <> 'NaN'::numeric AND base_amount NOT IN ('Infinity'::numeric,'-Infinity'::numeric)),
 FOREIGN KEY (transaction_id,ledger_id) REFERENCES transactions(id,ledger_id) ON DELETE CASCADE,
 FOREIGN KEY (item_id,ledger_id,currency) REFERENCES items(id,ledger_id,currency)
);
CREATE INDEX entries_transaction_idx ON transaction_entries(transaction_id);
CREATE INDEX entries_item_idx ON transaction_entries(ledger_id,item_id);
CREATE FUNCTION lock_entry_transactions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Writers touching a transaction serialize before changing entries.
 PERFORM id FROM transactions WHERE id IN (NEW.transaction_id,OLD.transaction_id) ORDER BY id FOR UPDATE;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entries_lock BEFORE INSERT OR UPDATE OR DELETE ON transaction_entries
 FOR EACH ROW EXECUTE FUNCTION lock_entry_transactions();
CREATE FUNCTION assert_transaction_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 targets uuid[];
 target uuid;
 entry_count bigint;
 total numeric;
BEGIN
 IF TG_TABLE_NAME='transactions' THEN targets:=ARRAY[NEW.id,OLD.id];
 ELSE targets:=ARRAY[NEW.transaction_id,OLD.transaction_id]; END IF;
 FOR target IN SELECT DISTINCT x FROM unnest(targets) AS x WHERE x IS NOT NULL LOOP
  IF EXISTS (SELECT 1 FROM transactions WHERE id=target) THEN
   SELECT count(*),coalesce(sum(base_amount),0) INTO entry_count,total
    FROM transaction_entries WHERE transaction_id=target;
   IF entry_count<2 OR total<>0 THEN
    RAISE EXCEPTION 'transaction requires at least two entries and exact zero base sum' USING ERRCODE='23514';
   END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transactions_balanced AFTER INSERT OR UPDATE ON transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_transaction_balance();
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT OR UPDATE OR DELETE ON transaction_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_transaction_balance();
CREATE TABLE exchange_rates (
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 rate_date date NOT NULL,
 from_currency text NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
 to_currency text NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$'),
 rate numeric(24,10) NOT NULL CHECK (rate>0 AND rate<>'NaN'::numeric AND rate<>'Infinity'::numeric),
 as_of_source boolean NOT NULL DEFAULT false,
 PRIMARY KEY (ledger_id,rate_date,from_currency,to_currency),
 CHECK (from_currency<>to_currency OR rate=1)
);
CREATE TABLE import_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
 source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
 source_system text NOT NULL,
 status text NOT NULL CHECK (status IN ('validated','imported','failed')),
 report jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (id,ledger_id)
);
CREATE UNIQUE INDEX imported_source_sha_idx ON import_jobs(ledger_id,source_sha256) WHERE status='imported';
CREATE TABLE import_source_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_id uuid NOT NULL,
 import_job_id uuid NOT NULL,
 source_table text NOT NULL,
 source_key text NOT NULL,
 target_table text NOT NULL CHECK (target_table IN ('items','payees','projects','exchange_rates','transactions')),
 target_id text NOT NULL,
 FOREIGN KEY (import_job_id,ledger_id) REFERENCES import_jobs(id,ledger_id) ON DELETE CASCADE,
 UNIQUE (import_job_id,source_table,source_key,target_table,target_id)
);
