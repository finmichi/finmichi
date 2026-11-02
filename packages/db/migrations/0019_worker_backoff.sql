ALTER TABLE recurring_worker_runs
 ADD COLUMN failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 ADD COLUMN next_retry_at timestamptz;
