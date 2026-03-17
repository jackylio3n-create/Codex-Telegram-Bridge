package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"codextelegrambridge/internal/model"
)

func TestStoreSessionAndPendingActionLifecycle(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "bridge.db")
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	session := model.Session{
		SessionID:        "session-1",
		WorkspaceRoot:    "/tmp/workspace",
		ExtraAllowedDirs: []string{"/tmp/workspace/sub"},
		CWD:              "/tmp/workspace",
		Mode:             model.ModeCode,
		AccessScope:      model.ScopeSystem,
		RunState:         model.RunIdle,
		CreatedAt:        time.Now().UTC(),
		UpdatedAt:        time.Now().UTC(),
	}
	if err := store.SaveSession(ctx, session); err != nil {
		t.Fatalf("save session: %v", err)
	}
	if err := store.SetCurrentSessionID(ctx, session.SessionID); err != nil {
		t.Fatalf("set current session: %v", err)
	}

	current, err := store.GetCurrentSession(ctx)
	if err != nil {
		t.Fatalf("get current session: %v", err)
	}
	if current == nil || current.SessionID != session.SessionID {
		t.Fatalf("unexpected current session: %#v", current)
	}

	action := model.PendingAction{
		ActionID:   "action-1",
		ActionType: "approval",
		SessionID:  session.SessionID,
		RunID:      "run-1",
		ChatID:     "chat-1",
		UserID:     "user-1",
		Payload: map[string]string{
			"summary": "git status",
		},
		ExpiresAt: time.Now().UTC().Add(-time.Minute),
	}
	if err := store.CreatePendingAction(ctx, action); err != nil {
		t.Fatalf("create pending action: %v", err)
	}

	expired, err := store.ExpirePendingActions(ctx, time.Now().UTC())
	if err != nil {
		t.Fatalf("expire pending actions: %v", err)
	}
	if len(expired) != 1 || expired[0].ActionID != action.ActionID {
		t.Fatalf("unexpected expired actions: %#v", expired)
	}

	auth, err := store.GetOrCreateTelegramUserAuth(ctx, "user-1", "chat-1")
	if err != nil {
		t.Fatalf("get or create auth: %v", err)
	}
	if auth == nil || auth.UserID != "user-1" {
		t.Fatalf("unexpected auth: %#v", auth)
	}
	if err := store.MarkVerified(ctx, "user-1", "chat-1"); err != nil {
		t.Fatalf("mark verified: %v", err)
	}
	auth, err = store.GetTelegramUserAuth(ctx, "user-1")
	if err != nil {
		t.Fatalf("reload auth: %v", err)
	}
	if auth.VerifiedAt == nil {
		t.Fatalf("expected verified_at to be set")
	}
}

func TestCleanupRemovesDeniedPendingActions(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "bridge.db")
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	session := model.Session{
		SessionID:     "session-cleanup",
		WorkspaceRoot: "/tmp/workspace",
		CWD:           "/tmp/workspace",
		Mode:          model.ModeCode,
		AccessScope:   model.ScopeWorkspace,
		RunState:      model.RunIdle,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}
	if err := store.SaveSession(ctx, session); err != nil {
		t.Fatalf("save session: %v", err)
	}

	action := model.PendingAction{
		ActionID:   "action-denied",
		ActionType: "approval",
		SessionID:  session.SessionID,
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
	}
	if err := store.CreatePendingAction(ctx, action); err != nil {
		t.Fatalf("create pending action: %v", err)
	}
	if err := store.ResolvePendingAction(ctx, action.ActionID, string(model.ResolutionDenied)); err != nil {
		t.Fatalf("resolve pending action: %v", err)
	}

	if err := store.Cleanup(ctx, time.Now().UTC().Add(time.Hour), time.Now().UTC().Add(-time.Hour), 100); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	reloaded, err := store.GetPendingAction(ctx, action.ActionID)
	if err != nil {
		t.Fatalf("reload pending action: %v", err)
	}
	if reloaded != nil {
		t.Fatalf("expected denied pending action to be deleted, got %#v", reloaded)
	}
}

func TestStoreAcceptsPlanChoicePendingAction(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "bridge.db")
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	session := model.Session{
		SessionID:     "session-plan",
		WorkspaceRoot: "/tmp/workspace",
		CWD:           "/tmp/workspace",
		Mode:          model.ModePlan,
		AccessScope:   model.ScopeWorkspace,
		RunState:      model.RunIdle,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}
	if err := store.SaveSession(ctx, session); err != nil {
		t.Fatalf("save session: %v", err)
	}

	action := model.PendingAction{
		ActionID:   "action-plan",
		ActionType: string(model.ActionPlanChoice),
		SessionID:  session.SessionID,
		Payload: map[string]string{
			"summary": "Choose a plan",
		},
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
	if err := store.CreatePendingAction(ctx, action); err != nil {
		t.Fatalf("create plan choice action: %v", err)
	}
}

func TestPruneSessionsKeepsCurrentAndPending(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "bridge.db")
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)
	sessionIDs := []string{"session-a", "session-b", "session-c", "session-d"}
	for index, sessionID := range sessionIDs {
		session := model.Session{
			SessionID:     sessionID,
			WorkspaceRoot: "/tmp/workspace",
			CWD:           "/tmp/workspace",
			Mode:          model.ModeCode,
			AccessScope:   model.ScopeWorkspace,
			RunState:      model.RunIdle,
			CreatedAt:     base.Add(time.Duration(index) * time.Minute),
			UpdatedAt:     base.Add(time.Duration(index) * time.Minute),
		}
		if err := store.SaveSession(ctx, session); err != nil {
			t.Fatalf("save session %s: %v", sessionID, err)
		}
	}
	if err := store.SetCurrentSessionID(ctx, "session-a"); err != nil {
		t.Fatalf("set current session: %v", err)
	}
	if err := store.CreatePendingAction(ctx, model.PendingAction{
		ActionID:   "action-pending",
		ActionType: string(model.ActionApproval),
		SessionID:  "session-b",
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatalf("create pending action: %v", err)
	}

	if err := store.PruneSessions(ctx, "session-a", 1); err != nil {
		t.Fatalf("prune sessions: %v", err)
	}

	sessions, err := store.ListSessions(ctx)
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions after prune, got %d", len(sessions))
	}
	kept := map[string]bool{}
	for _, session := range sessions {
		kept[session.SessionID] = true
	}
	for _, sessionID := range []string{"session-a", "session-b", "session-d"} {
		if !kept[sessionID] {
			t.Fatalf("expected session %s to be kept", sessionID)
		}
	}
	if kept["session-c"] {
		t.Fatalf("expected session-c to be pruned")
	}
}

func TestOpenBackfillsMissingMigrationRecords(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "bridge.db")
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?_foreign_keys=on")
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}

	mustExec := func(sqlText string, args ...any) {
		t.Helper()
		if _, err := db.Exec(sqlText, args...); err != nil {
			t.Fatalf("exec %q: %v", sqlText, err)
		}
	}
	lookupMigration := func(id string) migration {
		t.Helper()
		for _, candidate := range migrations {
			if candidate.ID == id {
				return candidate
			}
		}
		t.Fatalf("migration %s not found", id)
		return migration{}
	}

	mustExec(`
CREATE TABLE schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`)

	appliedIDs := []string{
		"0001_initial_schema",
		"0004_session_access_scope",
		"0005_telegram_user_auth",
		"0006_telegram_user_language",
		"0007_minimal_single_user_state",
		"0008_drop_legacy_state_tables",
		"0009_pending_action_plan_choice",
	}
	for _, id := range appliedIDs {
		migration := lookupMigration(id)
		mustExec(migration.SQL)
		mustExec(`INSERT INTO schema_migrations (migration_id, applied_at) VALUES (?, ?)`, id, time.Now().UTC().Format(time.RFC3339))
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close raw sqlite: %v", err)
	}

	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	for _, id := range []string{"0002_pending_permission_read_indexes", "0003_audit_log_session_event_created"} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM schema_migrations WHERE migration_id = ?`, id).Scan(&count); err != nil {
			t.Fatalf("count migration %s: %v", id, err)
		}
		if count != 1 {
			t.Fatalf("expected migration %s to be backfilled once, got %d", id, count)
		}
	}

	var indexCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM sqlite_master WHERE type = 'index' AND name = ?`, "idx_audit_logs_session_event_created").Scan(&indexCount); err != nil {
		t.Fatalf("count audit index: %v", err)
	}
	if indexCount != 1 {
		t.Fatalf("expected audit index to exist, got %d", indexCount)
	}
}
