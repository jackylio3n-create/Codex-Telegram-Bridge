ALTER TABLE pending_actions RENAME TO pending_actions_old;

CREATE TABLE pending_actions (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL CHECK (action_type IN ('approval', 'adddir_confirm', 'plan_choice')),
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id TEXT,
  chat_id TEXT,
  user_id TEXT,
  source_message_id TEXT,
  payload_json TEXT,
  expires_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  resolution TEXT CHECK (resolution IN ('approved', 'denied', 'expired') OR resolution IS NULL),
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO pending_actions (
  action_id,
  action_type,
  session_id,
  run_id,
  chat_id,
  user_id,
  source_message_id,
  payload_json,
  expires_at,
  resolved,
  resolution,
  resolved_at,
  created_at
)
SELECT
  action_id,
  action_type,
  session_id,
  run_id,
  chat_id,
  user_id,
  source_message_id,
  payload_json,
  expires_at,
  resolved,
  resolution,
  resolved_at,
  created_at
FROM pending_actions_old;

DROP TABLE pending_actions_old;

CREATE INDEX IF NOT EXISTS idx_pending_actions_session_resolved_created
  ON pending_actions (session_id, resolved, created_at DESC, action_id ASC);

CREATE INDEX IF NOT EXISTS idx_pending_actions_resolved_expires
  ON pending_actions (resolved, expires_at);
