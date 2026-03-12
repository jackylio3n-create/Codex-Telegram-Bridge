CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_actions (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL CHECK (action_type IN ('approval', 'adddir_confirm')),
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

CREATE INDEX IF NOT EXISTS idx_pending_actions_session_resolved_created
  ON pending_actions (session_id, resolved, created_at DESC, action_id ASC);

CREATE INDEX IF NOT EXISTS idx_pending_actions_resolved_expires
  ON pending_actions (resolved, expires_at);

INSERT INTO settings (key, value_json, updated_at)
SELECT 'telegram_offset',
       CAST(current_offset AS TEXT),
       updated_at
FROM channel_offsets
WHERE channel_key = 'telegram:getUpdates'
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'telegram_offset')
ORDER BY updated_at DESC, channel_key ASC
LIMIT 1;

INSERT INTO settings (key, value_json, updated_at)
SELECT 'current_session_id',
       json_quote(session_id),
       updated_at
FROM chat_bindings
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'current_session_id')
ORDER BY updated_at DESC, chat_id ASC
LIMIT 1;

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
SELECT permission_id,
       'approval',
       session_id,
       run_id,
       chat_id,
       user_id,
       source_message_id,
       json_object(
         'toolName', tool_name,
         'summary', summary
       ),
       expires_at,
       resolved,
       resolution,
       resolved_at,
       created_at
FROM pending_permissions
WHERE NOT EXISTS (
  SELECT 1 FROM pending_actions
  WHERE pending_actions.action_id = pending_permissions.permission_id
);
