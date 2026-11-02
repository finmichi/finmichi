CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 oidc_issuer text NOT NULL,
 oidc_subject text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (oidc_issuer, oidc_subject)
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 CHECK (expires_at > created_at)
);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE audit_logs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at);
