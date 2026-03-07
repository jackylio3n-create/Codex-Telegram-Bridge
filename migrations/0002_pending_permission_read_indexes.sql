CREATE INDEX IF NOT EXISTS idx_pending_permissions_session_resolved_created
  ON pending_permissions (session_id, resolved, created_at DESC, permission_id ASC);
