CREATE INDEX IF NOT EXISTS idx_audit_logs_session_event_created
  ON audit_logs (session_id, event_type, created_at DESC, audit_id DESC);
