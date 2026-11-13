CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Only SHA-256 hashes of tokens are stored; a DB leak does not leak usable credentials.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_tokens_email ON login_tokens (email, created_at);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE subscriptions (
  user_id                TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL,
  current_period_end     INTEGER,
  updated_at             INTEGER NOT NULL
);

-- Stripe retries webhooks; this makes handling idempotent.
CREATE TABLE stripe_events (
  id          TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
