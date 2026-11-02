ALTER TABLE audit_logs ADD COLUMN source_ip inet;
ALTER TABLE audit_logs ADD COLUMN subject_hash text CHECK (subject_hash IS NULL OR subject_hash ~ '^[a-f0-9]{64}$');
