-- ADR-0012: global public caches only; excluded from ledger backup.
CREATE TABLE market_fx_rates (
 rate_date date NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$' AND currency<>'TWD'),
 spot_buy numeric(24,10) CHECK(spot_buy>0),spot_sell numeric(24,10) CHECK(spot_sell>0),
 cash_buy numeric(24,10) CHECK(cash_buy>0),cash_sell numeric(24,10) CHECK(cash_sell>0),
 source text NOT NULL CHECK(source='bot'),method text NOT NULL DEFAULT 'fetch' CHECK(method IN ('fetch','upload')),
 fetched_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(rate_date,currency,source)
);
CREATE INDEX market_fx_lookup ON market_fx_rates(currency,source,rate_date DESC);
CREATE TABLE market_prices (
 trade_date date NOT NULL,market text NOT NULL CHECK(market IN ('TWSE','TPEx')),
 symbol text NOT NULL CHECK(symbol ~ '^[A-Z0-9]{4,6}$'),close numeric(20,6) NOT NULL CHECK(close>=0),
 source text NOT NULL CHECK((market='TWSE' AND source='twse') OR (market='TPEx' AND source='tpex')),
 fetched_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(trade_date,market,symbol,source)
);
CREATE INDEX market_price_lookup ON market_prices(market,symbol,trade_date DESC);
CREATE TABLE market_calendar (
 date date NOT NULL,market text NOT NULL CHECK(market='TWSE'),is_trading_day boolean NOT NULL,
 source text NOT NULL CHECK(source='twse'),fetched_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(date,market)
);
CREATE TABLE market_fetch_runs (
 source text PRIMARY KEY CHECK(source IN ('bot','twse','tpex','calendar')),
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','success','warning','error','blocked_by_source','no_new_data','skipped_holiday')),
 method text NOT NULL DEFAULT 'fetch' CHECK(method IN ('fetch','upload')),
 scheduled_key text,last_started_at timestamptz,last_finished_at timestamptz,data_date date,received_date date,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z_]{1,64}$'),
 row_count integer NOT NULL DEFAULT 0 CHECK(row_count>=0),skipped_no_price integer NOT NULL DEFAULT 0 CHECK(skipped_no_price>=0),
 skipped_no_rate integer NOT NULL DEFAULT 0 CHECK(skipped_no_rate>=0),
 failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),next_retry_at timestamptz,
 blocked_date date,blocked_attempts integer NOT NULL DEFAULT 0 CHECK(blocked_attempts BETWEEN 0 AND 2),
 source_filename text,first_success_filename text
);
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_allowed;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_allowed CHECK(action IN ('login','logout','ledger.create','ledger.update','ledger.lock','ledger.unlock','ledger.delete','item.create','item.update','payees.create','payees.update','payees.delete','projects.create','projects.update','projects.delete','memo_templates.create','memo_templates.update','memo_templates.delete','transaction.create','transaction.update','transaction.delete','life2023.import','emoney.import','backup.restore','backup.download','pat.create','pat.revoke','mcp.call','market.fx_upload','draft.create','draft.approve','draft.reject','draft.expire','recurring.create','recurring.update','recurring.delete','recurring.generate','recurring.post','recurring.skip','budget.update','budget.delete','card.update','card.delete','loan.update','loan.delete'));
