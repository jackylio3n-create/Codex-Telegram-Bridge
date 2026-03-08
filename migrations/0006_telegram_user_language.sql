ALTER TABLE telegram_user_auth
  ADD COLUMN preferred_language TEXT
  CHECK (preferred_language IS NULL OR preferred_language IN ('zh', 'en'));

CREATE INDEX IF NOT EXISTS idx_telegram_user_auth_language
  ON telegram_user_auth (preferred_language, updated_at DESC);
