ALTER TABLE sessions
  ADD COLUMN access_scope TEXT NOT NULL DEFAULT 'system'
  CHECK (access_scope IN ('workspace', 'system'));
