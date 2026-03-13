package store

import (
	"context"
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
