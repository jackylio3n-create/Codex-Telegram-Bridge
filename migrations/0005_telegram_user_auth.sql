CREATE TABLE IF NOT EXISTS telegram_user_auth (
  user_id TEXT PRIMARY KEY,
  latest_chat_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  verified_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failed_at TEXT,
  banned_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_user_auth_banned
  ON telegram_user_auth (banned_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_user_auth_verified
  ON telegram_user_auth (verified_at, updated_at DESC);
