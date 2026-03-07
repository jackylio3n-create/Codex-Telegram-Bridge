CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  extra_allowed_dirs_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'plan', 'code')),
  codex_thread_id TEXT,
  rolling_summary TEXT,
  run_state TEXT NOT NULL CHECK (
    run_state IN (
      'idle',
      'running',
      'waiting_approval',
      'cancelling',
      'cancelled',
      'failed',
      'stale_recovered'
    )
  ),
  cancellation_result TEXT CHECK (
    cancellation_result IN ('full', 'partial', 'unknown') OR cancellation_result IS NULL
  ),
  active_run_id TEXT,
  stale_recovered INTEGER NOT NULL DEFAULT 0 CHECK (stale_recovered IN (0, 1)),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_bindings (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_permissions (
  permission_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  resolution TEXT CHECK (resolution IN ('approved', 'denied', 'expired') OR resolution IS NULL),
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_permissions_session_run
  ON pending_permissions (session_id, run_id);

CREATE INDEX IF NOT EXISTS idx_pending_permissions_resolved_expires
  ON pending_permissions (resolved, expires_at);

CREATE TABLE IF NOT EXISTS channel_offsets (
  channel_key TEXT PRIMARY KEY,
  current_offset INTEGER NOT NULL CHECK (current_offset >= 0),
  previous_offset INTEGER NOT NULL CHECK (previous_offset >= 0),
  updated_at TEXT NOT NULL,
  CHECK (current_offset >= previous_offset)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  chat_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_session_created
  ON audit_logs (session_id, created_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_chat_created
  ON audit_logs (chat_id, created_at DESC, audit_id DESC);

CREATE TABLE IF NOT EXISTS session_summaries (
  summary_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  summary_kind TEXT NOT NULL DEFAULT 'rolling',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_session_created
  ON session_summaries (session_id, created_at DESC, summary_id DESC);
