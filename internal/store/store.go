package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"codextelegrambridge/internal/model"
	_ "github.com/mattn/go-sqlite3"
)

type Store struct {
	db *sql.DB
	mu sync.Mutex
}

func Open(databasePath string) (*Store, error) {
	db, err := sql.Open("sqlite3", "file:"+databasePath+"?_foreign_keys=on")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)

	store := &Store{db: db}
	if err := store.applyMigrations(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) GetTelegramOffset(ctx context.Context) (int64, error) {
	return s.getIntSetting(ctx, "telegram_offset")
}

func (s *Store) SetTelegramOffset(ctx context.Context, offset int64) error {
	return s.setSetting(ctx, "telegram_offset", offset)
}

func (s *Store) GetCurrentSessionID(ctx context.Context) (string, error) {
	return s.getStringSetting(ctx, "current_session_id")
}

func (s *Store) SetCurrentSessionID(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return s.setJSONSetting(ctx, "current_session_id", nil)
	}
	return s.setJSONSetting(ctx, "current_session_id", sessionID)
}

func (s *Store) GetOwnerChatID(ctx context.Context) (string, error) {
	return s.getStringSetting(ctx, "owner_chat_id")
}

func (s *Store) SetOwnerChatID(ctx context.Context, chatID string) error {
	if chatID == "" {
		return s.setJSONSetting(ctx, "owner_chat_id", nil)
	}
	return s.setJSONSetting(ctx, "owner_chat_id", chatID)
}

func (s *Store) SaveSession(ctx context.Context, session model.Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if session.CreatedAt.IsZero() {
		session.CreatedAt = time.Now().UTC()
	}
	if session.UpdatedAt.IsZero() {
		session.UpdatedAt = session.CreatedAt
	}

	extraJSON, err := json.Marshal(session.ExtraAllowedDirs)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
INSERT INTO sessions (
  session_id,
  workspace_root,
  extra_allowed_dirs_json,
  cwd,
  mode,
  codex_thread_id,
  rolling_summary,
  run_state,
  cancellation_result,
  active_run_id,
  stale_recovered,
  last_error,
  created_at,
  updated_at,
  access_scope
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  workspace_root = excluded.workspace_root,
  extra_allowed_dirs_json = excluded.extra_allowed_dirs_json,
  cwd = excluded.cwd,
  mode = excluded.mode,
  codex_thread_id = excluded.codex_thread_id,
  rolling_summary = excluded.rolling_summary,
  run_state = excluded.run_state,
  cancellation_result = excluded.cancellation_result,
  active_run_id = excluded.active_run_id,
  stale_recovered = excluded.stale_recovered,
  last_error = excluded.last_error,
  updated_at = excluded.updated_at,
  access_scope = excluded.access_scope
`, session.SessionID, session.WorkspaceRoot, string(extraJSON), session.CWD, string(session.Mode), nullString(session.CodexThreadID), nullString(session.RollingSummary), string(session.RunState), nullString(session.CancellationResult), nullString(session.ActiveRunID), boolToInt(session.StaleRecovered), nullString(session.LastError), session.CreatedAt.UTC().Format(time.RFC3339), session.UpdatedAt.UTC().Format(time.RFC3339), string(session.AccessScope))
	return err
}

func (s *Store) GetSession(ctx context.Context, sessionID string) (*model.Session, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT
  session_id,
  workspace_root,
  extra_allowed_dirs_json,
  cwd,
  mode,
  codex_thread_id,
  rolling_summary,
  run_state,
  cancellation_result,
  active_run_id,
  stale_recovered,
  last_error,
  created_at,
  updated_at,
  access_scope
FROM sessions WHERE session_id = ?
`, sessionID)
	return scanSession(row)
}

func (s *Store) GetCurrentSession(ctx context.Context) (*model.Session, error) {
	sessionID, err := s.GetCurrentSessionID(ctx)
	if err != nil || sessionID == "" {
		return nil, err
	}
	return s.GetSession(ctx, sessionID)
}

func (s *Store) ListSessions(ctx context.Context) ([]model.Session, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT
  session_id,
  workspace_root,
  extra_allowed_dirs_json,
  cwd,
  mode,
  codex_thread_id,
  rolling_summary,
  run_state,
  cancellation_result,
  active_run_id,
  stale_recovered,
  last_error,
  created_at,
  updated_at,
  access_scope
FROM sessions ORDER BY updated_at DESC
`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []model.Session
	for rows.Next() {
		session, err := scanSessionFromRows(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, *session)
	}
	return sessions, rows.Err()
}

func (s *Store) GetOrCreateTelegramUserAuth(ctx context.Context, userID, chatID string) (*model.TelegramUserAuth, error) {
	auth, err := s.GetTelegramUserAuth(ctx, userID)
	if err != nil {
		return nil, err
	}
	if auth != nil {
		if auth.LatestChatID != chatID {
			auth.LatestChatID = chatID
			auth.UpdatedAt = time.Now().UTC()
			if err := s.saveTelegramUserAuth(ctx, *auth); err != nil {
				return nil, err
			}
		}
		return auth, nil
	}

	now := time.Now().UTC()
	newAuth := model.TelegramUserAuth{
		UserID:       userID,
		LatestChatID: chatID,
		FirstSeenAt:  now,
		UpdatedAt:    now,
	}
	if err := s.saveTelegramUserAuth(ctx, newAuth); err != nil {
		return nil, err
	}
	return &newAuth, nil
}

func (s *Store) GetTelegramUserAuth(ctx context.Context, userID string) (*model.TelegramUserAuth, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
FROM telegram_user_auth
WHERE user_id = ?
`, userID)
	return scanAuth(row)
}

func (s *Store) FindTelegramUserAuthByChatID(ctx context.Context, chatID string) (*model.TelegramUserAuth, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
FROM telegram_user_auth
WHERE latest_chat_id = ?
`, chatID)
	return scanAuth(row)
}

func (s *Store) MarkVerified(ctx context.Context, userID, chatID string) error {
	auth, err := s.GetOrCreateTelegramUserAuth(ctx, userID, chatID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	auth.LatestChatID = chatID
	auth.VerifiedAt = &now
	auth.FailedAttempts = 0
	auth.LastFailedAt = nil
	auth.BannedAt = nil
	auth.UpdatedAt = now
	return s.saveTelegramUserAuth(ctx, *auth)
}

func (s *Store) RecordFailedAttempt(ctx context.Context, userID, chatID string, banThreshold int) (*model.TelegramUserAuth, error) {
	auth, err := s.GetOrCreateTelegramUserAuth(ctx, userID, chatID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	auth.FailedAttempts++
	auth.LastFailedAt = &now
	auth.UpdatedAt = now
	if auth.FailedAttempts >= banThreshold {
		auth.BannedAt = &now
	}
	if err := s.saveTelegramUserAuth(ctx, *auth); err != nil {
		return nil, err
	}
	return auth, nil
}

func (s *Store) SetPreferredLanguage(ctx context.Context, userID, chatID, language string) error {
	auth, err := s.GetOrCreateTelegramUserAuth(ctx, userID, chatID)
	if err != nil {
		return err
	}
	auth.PreferredLanguage = language
	auth.UpdatedAt = time.Now().UTC()
	return s.saveTelegramUserAuth(ctx, *auth)
}

func (s *Store) CreatePendingAction(ctx context.Context, action model.PendingAction) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if action.CreatedAt.IsZero() {
		action.CreatedAt = time.Now().UTC()
	}
	payloadJSON, err := json.Marshal(action.Payload)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
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
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, action.ActionID, action.ActionType, action.SessionID, nullString(action.RunID), nullString(action.ChatID), nullString(action.UserID), nullString(action.SourceMessageID), string(payloadJSON), action.ExpiresAt.UTC().Format(time.RFC3339), boolToInt(action.Resolved), nullString(action.Resolution), nullableTime(action.ResolvedAt), action.CreatedAt.UTC().Format(time.RFC3339))
	return err
}

func (s *Store) GetPendingAction(ctx context.Context, actionID string) (*model.PendingAction, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT action_id, action_type, session_id, run_id, chat_id, user_id, source_message_id, payload_json, expires_at, resolved, resolution, resolved_at, created_at
FROM pending_actions
WHERE action_id = ?
`, actionID)
	return scanPendingAction(row)
}

func (s *Store) ListPendingActions(ctx context.Context, unresolvedOnly bool) ([]model.PendingAction, error) {
	query := `
SELECT action_id, action_type, session_id, run_id, chat_id, user_id, source_message_id, payload_json, expires_at, resolved, resolution, resolved_at, created_at
FROM pending_actions`
	if unresolvedOnly {
		query += " WHERE resolved = 0"
	}
	query += " ORDER BY created_at DESC"

	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var actions []model.PendingAction
	for rows.Next() {
		action, err := scanPendingActionFromRows(rows)
		if err != nil {
			return nil, err
		}
		actions = append(actions, *action)
	}
	return actions, rows.Err()
}

func (s *Store) ResolvePendingAction(ctx context.Context, actionID, resolution string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `
UPDATE pending_actions
SET resolved = 1, resolution = ?, resolved_at = ?
WHERE action_id = ? AND resolved = 0
`, resolution, now, actionID)
	return err
}

func (s *Store) ExpirePendingActions(ctx context.Context, now time.Time) ([]model.PendingAction, error) {
	actions, err := s.ListPendingActions(ctx, true)
	if err != nil {
		return nil, err
	}
	var expired []model.PendingAction
	for _, action := range actions {
		if !action.ExpiresAt.After(now) {
			if err := s.ResolvePendingAction(ctx, action.ActionID, string(model.ResolutionExpired)); err != nil {
				return nil, err
			}
			action.Resolved = true
			action.Resolution = string(model.ResolutionExpired)
			expired = append(expired, action)
		}
	}
	return expired, nil
}

func (s *Store) AppendAudit(ctx context.Context, audit model.AuditRecord) error {
	payloadJSON, err := json.Marshal(audit.Payload)
	if err != nil {
		return err
	}
	if audit.CreatedAt.IsZero() {
		audit.CreatedAt = time.Now().UTC()
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO audit_logs (session_id, chat_id, run_id, event_type, payload_json, created_at)
VALUES (?, ?, ?, ?, ?, ?)
`, nullString(audit.SessionID), nullString(audit.ChatID), nullString(audit.RunID), audit.EventType, string(payloadJSON), audit.CreatedAt.UTC().Format(time.RFC3339))
	return err
}

func (s *Store) ListRecentAudit(ctx context.Context, sessionID string, limit int) ([]model.AuditRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT session_id, chat_id, run_id, event_type, payload_json, created_at
FROM audit_logs
WHERE session_id = ?
ORDER BY created_at DESC, audit_id DESC
LIMIT ?
`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []model.AuditRecord
	for rows.Next() {
		var audit model.AuditRecord
		var sessionID, chatID, runID sql.NullString
		var payloadJSON sql.NullString
		var createdAt string
		if err := rows.Scan(&sessionID, &chatID, &runID, &audit.EventType, &payloadJSON, &createdAt); err != nil {
			return nil, err
		}
		audit.SessionID = sessionID.String
		audit.ChatID = chatID.String
		audit.RunID = runID.String
		if payloadJSON.Valid && payloadJSON.String != "" {
			_ = json.Unmarshal([]byte(payloadJSON.String), &audit.Payload)
		}
		audit.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		records = append(records, audit)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].CreatedAt.Before(records[j].CreatedAt) })
	return records, rows.Err()
}

func (s *Store) Cleanup(ctx context.Context, resolvedOlderThan, expiredOlderThan time.Time, maxAuditRows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.ExecContext(ctx, `
DELETE FROM pending_actions
WHERE resolved = 1 AND resolution IN ('approved', 'denied') AND resolved_at < ?
`, resolvedOlderThan.UTC().Format(time.RFC3339))
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
DELETE FROM pending_actions
WHERE resolved = 1 AND resolution = 'expired' AND resolved_at < ?
`, expiredOlderThan.UTC().Format(time.RFC3339))
	if err != nil {
		return err
	}

	if maxAuditRows > 0 {
		_, err = s.db.ExecContext(ctx, `
DELETE FROM audit_logs
WHERE audit_id NOT IN (
  SELECT audit_id FROM audit_logs ORDER BY audit_id DESC LIMIT ?
)
`, maxAuditRows)
	}
	return err
}

func (s *Store) applyMigrations(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`); err != nil {
		return err
	}

	for _, migration := range migrations {
		var exists int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM schema_migrations WHERE migration_id = ?`, migration.ID).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			continue
		}

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migration.SQL); err != nil {
			if shouldIgnoreMigrationError(migration.ID, err) {
				if _, insertErr := tx.ExecContext(ctx, `INSERT INTO schema_migrations (migration_id, applied_at) VALUES (?, ?)`, migration.ID, time.Now().UTC().Format(time.RFC3339)); insertErr != nil {
					tx.Rollback()
					return insertErr
				}
				if err := tx.Commit(); err != nil {
					return err
				}
				continue
			}
			tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", migration.ID, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (migration_id, applied_at) VALUES (?, ?)`, migration.ID, time.Now().UTC().Format(time.RFC3339)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) getIntSetting(ctx context.Context, key string) (int64, error) {
	row := s.db.QueryRowContext(ctx, `SELECT value_json FROM settings WHERE key = ?`, key)
	var raw string
	if err := row.Scan(&raw); err != nil {
		if err == sql.ErrNoRows {
			return 0, nil
		}
		return 0, err
	}
	var value int64
	if _, err := fmt.Sscanf(raw, "%d", &value); err != nil {
		return 0, nil
	}
	return value, nil
}

func (s *Store) getStringSetting(ctx context.Context, key string) (string, error) {
	row := s.db.QueryRowContext(ctx, `SELECT value_json FROM settings WHERE key = ?`, key)
	var raw string
	if err := row.Scan(&raw); err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return "", nil
	}
	var decoded string
	if err := json.Unmarshal([]byte(raw), &decoded); err == nil {
		return decoded, nil
	}
	return raw, nil
}

func (s *Store) setSetting(ctx context.Context, key string, value int64) error {
	return s.setRawSetting(ctx, key, fmt.Sprintf("%d", value))
}

func (s *Store) setJSONSetting(ctx context.Context, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.setRawSetting(ctx, key, string(encoded))
}

func (s *Store) setRawSetting(ctx context.Context, key, raw string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO settings (key, value_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
`, key, raw, time.Now().UTC().Format(time.RFC3339))
	return err
}

func shouldIgnoreMigrationError(migrationID string, err error) bool {
	message := strings.ToLower(err.Error())
	switch migrationID {
	case "0004_session_access_scope", "0006_telegram_user_language":
		return strings.Contains(message, "duplicate column name")
	default:
		return false
	}
}

func (s *Store) saveTelegramUserAuth(ctx context.Context, auth model.TelegramUserAuth) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO telegram_user_auth (
  user_id,
  latest_chat_id,
  first_seen_at,
  verified_at,
  failed_attempts,
  last_failed_at,
  banned_at,
  updated_at,
  preferred_language
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
  latest_chat_id = excluded.latest_chat_id,
  verified_at = excluded.verified_at,
  failed_attempts = excluded.failed_attempts,
  last_failed_at = excluded.last_failed_at,
  banned_at = excluded.banned_at,
  updated_at = excluded.updated_at,
  preferred_language = excluded.preferred_language
`, auth.UserID, auth.LatestChatID, auth.FirstSeenAt.UTC().Format(time.RFC3339), nullableTime(auth.VerifiedAt), auth.FailedAttempts, nullableTime(auth.LastFailedAt), nullableTime(auth.BannedAt), auth.UpdatedAt.UTC().Format(time.RFC3339), nullString(auth.PreferredLanguage))
	return err
}

func scanSession(row interface {
	Scan(dest ...any) error
}) (*model.Session, error) {
	session := &model.Session{}
	var extraJSON string
	var mode, runState, accessScope string
	var codexThreadID, rollingSummary, cancellationResult, activeRunID, lastError sql.NullString
	var staleRecovered int
	var createdAt, updatedAt string
	if err := row.Scan(&session.SessionID, &session.WorkspaceRoot, &extraJSON, &session.CWD, &mode, &codexThreadID, &rollingSummary, &runState, &cancellationResult, &activeRunID, &staleRecovered, &lastError, &createdAt, &updatedAt, &accessScope); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	_ = json.Unmarshal([]byte(extraJSON), &session.ExtraAllowedDirs)
	session.Mode = model.SessionMode(mode)
	session.CodexThreadID = codexThreadID.String
	session.RollingSummary = rollingSummary.String
	session.RunState = model.SessionRunState(runState)
	session.CancellationResult = cancellationResult.String
	session.ActiveRunID = activeRunID.String
	session.StaleRecovered = staleRecovered == 1
	session.LastError = lastError.String
	session.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	session.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	session.AccessScope = model.SessionAccessScope(accessScope)
	return session, nil
}

func scanSessionFromRows(rows *sql.Rows) (*model.Session, error) {
	return scanSession(rows)
}

func scanAuth(row interface {
	Scan(dest ...any) error
}) (*model.TelegramUserAuth, error) {
	auth := &model.TelegramUserAuth{}
	var firstSeenAt, updatedAt string
	var verifiedAt, lastFailedAt, bannedAt sql.NullString
	var preferredLanguage sql.NullString
	if err := row.Scan(&auth.UserID, &auth.LatestChatID, &firstSeenAt, &verifiedAt, &preferredLanguage, &auth.FailedAttempts, &lastFailedAt, &bannedAt, &updatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	auth.FirstSeenAt, _ = time.Parse(time.RFC3339, firstSeenAt)
	auth.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	auth.PreferredLanguage = preferredLanguage.String
	if verifiedAt.Valid {
		parsed, _ := time.Parse(time.RFC3339, verifiedAt.String)
		auth.VerifiedAt = &parsed
	}
	if lastFailedAt.Valid {
		parsed, _ := time.Parse(time.RFC3339, lastFailedAt.String)
		auth.LastFailedAt = &parsed
	}
	if bannedAt.Valid {
		parsed, _ := time.Parse(time.RFC3339, bannedAt.String)
		auth.BannedAt = &parsed
	}
	return auth, nil
}

func scanPendingAction(row interface {
	Scan(dest ...any) error
}) (*model.PendingAction, error) {
	action := &model.PendingAction{}
	var runID, chatID, userID, sourceMessageID, payloadJSON, resolution, resolvedAt sql.NullString
	var expiresAt, createdAt string
	var resolved int
	if err := row.Scan(&action.ActionID, &action.ActionType, &action.SessionID, &runID, &chatID, &userID, &sourceMessageID, &payloadJSON, &expiresAt, &resolved, &resolution, &resolvedAt, &createdAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	action.RunID = runID.String
	action.ChatID = chatID.String
	action.UserID = userID.String
	action.SourceMessageID = sourceMessageID.String
	action.Resolved = resolved == 1
	action.Resolution = resolution.String
	action.Payload = map[string]string{}
	if payloadJSON.Valid && payloadJSON.String != "" {
		_ = json.Unmarshal([]byte(payloadJSON.String), &action.Payload)
	}
	action.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
	action.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	if resolvedAt.Valid {
		parsed, _ := time.Parse(time.RFC3339, resolvedAt.String)
		action.ResolvedAt = &parsed
	}
	return action, nil
}

func scanPendingActionFromRows(rows *sql.Rows) (*model.PendingAction, error) {
	return scanPendingAction(rows)
}

func nullString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableTime(value *time.Time) any {
	if value == nil || value.IsZero() {
		return nil
	}
	return value.UTC().Format(time.RFC3339)
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

type migration struct {
	ID  string
	SQL string
}

var migrations = []migration{
	{ID: "0001_initial_schema", SQL: `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  extra_allowed_dirs_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'plan', 'code')),
  codex_thread_id TEXT,
  rolling_summary TEXT,
  run_state TEXT NOT NULL CHECK (
    run_state IN ('idle', 'running', 'waiting_approval', 'cancelling', 'cancelled', 'failed', 'stale_recovered')
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
`},
	{ID: "0004_session_access_scope", SQL: `
ALTER TABLE sessions
  ADD COLUMN access_scope TEXT NOT NULL DEFAULT 'workspace'
  CHECK (access_scope IN ('workspace', 'system'));
`},
	{ID: "0005_telegram_user_auth", SQL: `
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
`},
	{ID: "0006_telegram_user_language", SQL: `
ALTER TABLE telegram_user_auth
  ADD COLUMN preferred_language TEXT
  CHECK (preferred_language IS NULL OR preferred_language IN ('zh', 'en'));

CREATE INDEX IF NOT EXISTS idx_telegram_user_auth_language
  ON telegram_user_auth (preferred_language, updated_at DESC);
`},
	{ID: "0007_minimal_single_user_state", SQL: `
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
       json_object('toolName', tool_name, 'summary', summary),
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
`},
	{ID: "0008_drop_legacy_state_tables", SQL: `
DROP TABLE IF EXISTS chat_bindings;
DROP TABLE IF EXISTS pending_permissions;
DROP TABLE IF EXISTS channel_offsets;
DROP TABLE IF EXISTS session_summaries;
`},
}
