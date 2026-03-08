ALTER TABLE sessions
  ADD COLUMN access_scope TEXT NOT NULL DEFAULT 'workspace'
  CHECK (access_scope IN ('workspace', 'system'));
