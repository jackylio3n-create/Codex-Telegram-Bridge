package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"codextelegrambridge/internal/codex"
	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/model"
	"codextelegrambridge/internal/policy"
	"codextelegrambridge/internal/store"
	"codextelegrambridge/internal/telegram"
)

func TestCoordinatorApprovalResumeFlow(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	logger := testLogger(t)
	coordinator := NewCoordinator(cfg, logger, storeHandle, client)

	api.PushUpdate(textUpdate(1, "/new"))
	api.PushUpdate(textUpdate(2, "run something that needs approval"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	action := waitForPendingAction(t, storeHandle, 10*time.Second)
	approvalMessage := api.WaitForSentMessage(t, "Codex needs approval", 10*time.Second)
	if action.Payload["summary"] != "git status (workspace_write_required)" {
		t.Fatalf("unexpected approval summary: %q", action.Payload["summary"])
	}

	api.PushUpdate(callbackUpdate(3, approvalMessage.MessageID, action.ActionID, true))
	api.WaitForEditedMessage(t, "Approved answer", 10*time.Second)

	if _, err := waitForCurrentSessionState(t, storeHandle, model.RunIdle, 10*time.Second); err != nil {
		t.Fatalf("wait for idle session: %v", err)
	}
	actionState, err := storeHandle.GetPendingAction(context.Background(), action.ActionID)
	if err != nil {
		t.Fatalf("reload pending action: %v", err)
	}
	if actionState == nil || actionState.Resolution != "approved" {
		t.Fatalf("unexpected pending action resolution: %#v", actionState)
	}
	if !api.HasSentText("Approval granted.") {
		t.Fatalf("expected approval granted message")
	}

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorPlanModePresentsChoicesAndContinuesSelectedOption(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(textUpdate(10, "/new"))
	api.PushUpdate(textUpdate(11, "/mode plan"))
	api.PushUpdate(textUpdate(12, "design the fix"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	planMessage := api.WaitForEditedMessage(t, "Plan ready:", 10*time.Second)
	if !strings.Contains(planMessage.Text, "Recommended") {
		t.Fatalf("expected recommended plan label, got %q", planMessage.Text)
	}

	var action *model.PendingAction
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		pending, err := storeHandle.ListPendingActions(context.Background(), true)
		if err != nil {
			t.Fatalf("list pending actions: %v", err)
		}
		for _, item := range pending {
			if item.ActionType == string(model.ActionPlanChoice) {
				action = &item
				break
			}
		}
		if action != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if action == nil {
		t.Fatal("timed out waiting for plan choice action")
	}

	choiceMessage := api.WaitForSentMessage(t, "Choose a plan to continue", 10*time.Second)
	api.PushUpdate(callbackDataUpdate(13, choiceMessage.MessageID, "pc:"+action.ActionID+":0"))
	api.WaitForEditedMessage(t, "Executed selected plan", 10*time.Second)

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorDoesNotDuplicateUpdatesWhenTelegramRepeatsOffsetWindow(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	api.SetRetainUpdates(true)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	logger := testLogger(t)
	coordinator := NewCoordinator(cfg, logger, storeHandle, client)
	api.PushUpdate(textUpdate(100, "/new"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	waitForSessionCount(t, storeHandle, 1, 5*time.Second)

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}

	sessions, err := storeHandle.ListSessions(context.Background())
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected exactly one session, got %d", len(sessions))
	}
}

func TestCoordinatorIgnoresRedeliveredTelegramMessageWithSameMessageID(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	api.SetRetainUpdates(true)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	logger := testLogger(t)
	coordinator := NewCoordinator(cfg, logger, storeHandle, client)
	api.PushUpdate(textUpdateWithMessageID(200, 1, "/new"))
	api.PushUpdate(textUpdateWithMessageID(201, 1, "/new"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	waitForSessionCount(t, storeHandle, 1, 5*time.Second)

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorNewSessionDefaultsToWorkspaceScope(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(textUpdate(300, "/new"))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	session, err := waitForCurrentSessionState(t, storeHandle, model.RunIdle, 5*time.Second)
	if err != nil {
		t.Fatalf("wait for session: %v", err)
	}
	if session.AccessScope != model.ScopeSystem {
		t.Fatalf("expected new session to default to system scope, got %s", session.AccessScope)
	}

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorIgnoresDuplicateFinalEditMessage(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeStaticMessageCodex(t, "Final answer"),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	api.rejectDuplicateEdits = true
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	coordinator := NewCoordinator(cfg, logger, storeHandle, client)

	api.PushUpdate(textUpdate(1, "/new"))
	api.PushUpdate(textUpdate(2, "say hello"))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	api.WaitForEditedMessage(t, "Final answer", 10*time.Second)
	if _, err := waitForCurrentSessionState(t, storeHandle, model.RunIdle, 10*time.Second); err != nil {
		t.Fatalf("wait for idle session: %v", err)
	}

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}

	if strings.Contains(logs.String(), "handle run finished failed") {
		t.Fatalf("expected duplicate final edit to be ignored, got logs: %s", logs.String())
	}
}

func TestCoordinatorAllowsLanguageSelectionWithoutVerificationPassword(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(textUpdate(400, "/start"))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	picker := api.WaitForSentMessage(t, "Please choose your prompt language", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(401, picker.MessageID, "lang:zh"))
	api.WaitForSentMessage(t, "语言已保存", 5*time.Second)

	auth, err := storeHandle.GetTelegramUserAuth(context.Background(), "1")
	if err != nil {
		t.Fatalf("reload auth: %v", err)
	}
	if auth == nil || auth.PreferredLanguage != "zh" {
		t.Fatalf("expected preferred language zh, got %#v", auth)
	}

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorBindsVerifiedOwnerChatAndRejectsOtherChats(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	passwordHash, err := policy.HashPassword("secret-pass")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		VerificationPasswordHash:      passwordHash,
		OwnerUserID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(textUpdateInChat(500, 1, 1, "/start"))
	api.PushUpdate(textUpdateInChat(501, 2, 1, "secret-pass"))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	picker := api.WaitForSentMessage(t, "Please choose your prompt language", 5*time.Second)
	api.PushUpdate(callbackDataUpdateInChat(502, 1, 1, picker.MessageID, "lang:zh"))
	api.WaitForSentMessage(t, "语言已保存", 5*time.Second)

	ownerChatID, err := storeHandle.GetOwnerChatID(context.Background())
	if err != nil {
		t.Fatalf("get owner chat id: %v", err)
	}
	if ownerChatID != "1" {
		t.Fatalf("expected owner chat to be bound to 1, got %q", ownerChatID)
	}

	api.PushUpdate(textUpdateInChat(503, 2, 2, "/new"))
	api.WaitForSentMessage(t, "This chat is not authorized for the bridge.", 5*time.Second)

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorRejectsApprovalCallbackBeforeVerification(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	passwordHash, err := policy.HashPassword("secret-pass")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		VerificationPasswordHash:      passwordHash,
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	session := model.Session{
		SessionID:     "session-auth",
		WorkspaceRoot: cfg.DefaultWorkspaceRoot,
		CWD:           cfg.DefaultWorkspaceRoot,
		Mode:          model.ModeCode,
		AccessScope:   model.ScopeWorkspace,
		RunState:      model.RunWaitingApproval,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}
	if err := storeHandle.SaveSession(context.Background(), session); err != nil {
		t.Fatalf("save session: %v", err)
	}
	if err := storeHandle.SetCurrentSessionID(context.Background(), session.SessionID); err != nil {
		t.Fatalf("set current session: %v", err)
	}
	action := model.PendingAction{
		ActionID:   "action-unverified",
		ActionType: string(model.ActionApproval),
		SessionID:  session.SessionID,
		RunID:      "run-1",
		ChatID:     "1",
		UserID:     "1",
		Payload: map[string]string{
			"summary": "git status",
		},
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
	if err := storeHandle.CreatePendingAction(context.Background(), action); err != nil {
		t.Fatalf("create pending action: %v", err)
	}

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(callbackDataUpdateInChat(600, 1, 1, 700, "pa:"+action.ActionID))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	time.Sleep(500 * time.Millisecond)
	reloaded, err := storeHandle.GetPendingAction(context.Background(), action.ActionID)
	if err != nil {
		t.Fatalf("reload action: %v", err)
	}
	if reloaded == nil || reloaded.Resolved {
		t.Fatalf("expected pending action to remain unresolved, got %#v", reloaded)
	}

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorNoSessionInputShowsRecoveryCardAndCanCreateSession(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(textUpdate(700, "fix the build"))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	recovery := api.WaitForSentMessage(t, "No session is selected.", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(701, recovery.MessageID, callbackNavNew))
	session, err := waitForCurrentSessionState(t, storeHandle, model.RunIdle, 5*time.Second)
	if err != nil {
		t.Fatalf("wait for session: %v", err)
	}
	if session == nil {
		t.Fatal("expected session to be created")
	}
	api.WaitForSentMessage(t, "Created and switched to", 5*time.Second)

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorCanSwitchSessionsFromRecentSessions(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	now := time.Now().UTC()
	sessionA := model.Session{
		SessionID:     "session-a",
		WorkspaceRoot: cfg.DefaultWorkspaceRoot,
		CWD:           filepath.Join(cfg.DefaultWorkspaceRoot, "api"),
		Mode:          model.ModeCode,
		AccessScope:   model.ScopeWorkspace,
		RunState:      model.RunIdle,
		CreatedAt:     now.Add(-time.Hour),
		UpdatedAt:     now.Add(-time.Minute),
	}
	sessionB := model.Session{
		SessionID:     "session-b",
		WorkspaceRoot: cfg.DefaultWorkspaceRoot,
		CWD:           filepath.Join(cfg.DefaultWorkspaceRoot, "worker"),
		Mode:          model.ModePlan,
		AccessScope:   model.ScopeSystem,
		RunState:      model.RunIdle,
		CreatedAt:     now.Add(-2 * time.Hour),
		UpdatedAt:     now,
	}
	if err := storeHandle.SaveSession(context.Background(), sessionA); err != nil {
		t.Fatalf("save session A: %v", err)
	}
	if err := storeHandle.SaveSession(context.Background(), sessionB); err != nil {
		t.Fatalf("save session B: %v", err)
	}
	if err := storeHandle.SetCurrentSessionID(context.Background(), sessionA.SessionID); err != nil {
		t.Fatalf("set current session: %v", err)
	}

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(textUpdate(710, "/start"))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	picker := api.WaitForSentMessage(t, "Please choose your prompt language", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(711, picker.MessageID, "lang:en"))
	api.WaitForSentMessage(t, "Language saved.", 5*time.Second)
	home := api.WaitForSentMessage(t, "Current session:", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(712, home.MessageID, callbackNavSessions))
	list := api.WaitForSentMessage(t, "Recent sessions:", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(713, list.MessageID, "sess:switch:session-b"))

	currentSessionID := waitForCurrentSessionIDValue(t, storeHandle, "session-b", 5*time.Second)
	if currentSessionID != "session-b" {
		t.Fatalf("expected current session to switch to session-b, got %q", currentSessionID)
	}
	api.WaitForSentMessage(t, "Switched to session-b.", 5*time.Second)

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

func TestCoordinatorCallbackSettingsUpdateSessionAndThinkLevel(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	cfg := config.Config{
		AppHome:                       filepath.Join(tempRoot, "app"),
		DatabasePath:                  filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:                   filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:                   filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:                 filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:                       filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:                     filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:              "telegram-token",
		OwnerUserID:                   "1",
		OwnerChatID:                   "1",
		DefaultWorkspaceRoot:          filepath.Join(tempRoot, "workspace"),
		LogLevel:                      "info",
		CodexExecutable:               writeFakeCodex(t),
		ResolvedApprovalRetentionDays: 7,
		ExpiredApprovalRetentionDays:  1,
		MaxAuditRows:                  1000,
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("ensure directories: %v", err)
	}
	if err := os.MkdirAll(cfg.DefaultWorkspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer storeHandle.Close()

	session := model.Session{
		SessionID:     "session-settings",
		WorkspaceRoot: cfg.DefaultWorkspaceRoot,
		CWD:           cfg.DefaultWorkspaceRoot,
		Mode:          model.ModeCode,
		AccessScope:   model.ScopeWorkspace,
		RunState:      model.RunIdle,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}
	if err := storeHandle.SaveSession(context.Background(), session); err != nil {
		t.Fatalf("save session: %v", err)
	}
	if err := storeHandle.SetCurrentSessionID(context.Background(), session.SessionID); err != nil {
		t.Fatalf("set current session: %v", err)
	}

	api := newFakeTelegramServer(t)
	defer api.Close()

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  api.Server.Client(),
		BaseURL:     api.Server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: api.Server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	coordinator := NewCoordinator(cfg, testLogger(t), storeHandle, client)
	api.PushUpdate(textUpdate(720, "/start"))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- coordinator.Run(ctx)
	}()

	picker := api.WaitForSentMessage(t, "Please choose your prompt language", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(721, picker.MessageID, "lang:en"))
	api.WaitForSentMessage(t, "Language saved.", 5*time.Second)
	home := api.WaitForSentMessage(t, "Current session:", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(722, home.MessageID, "mode:set:plan"))
	api.WaitForSentMessage(t, "Mode updated to plan", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(723, home.MessageID, "scope:set:system"))
	api.WaitForSentMessage(t, "Scope updated to system", 5*time.Second)
	api.PushUpdate(callbackDataUpdate(724, home.MessageID, "think:set:high"))
	api.WaitForSentMessage(t, "Updated think level to high.", 5*time.Second)

	updated, err := storeHandle.GetCurrentSession(context.Background())
	if err != nil {
		t.Fatalf("reload session: %v", err)
	}
	if updated == nil || updated.Mode != model.ModePlan || updated.AccessScope != model.ScopeSystem {
		t.Fatalf("unexpected session after callbacks: %#v", updated)
	}
	think, err := codex.ReadReasoningEffort(cfg.CodexHome)
	if err != nil {
		t.Fatalf("read think level: %v", err)
	}
	if think != "high" {
		t.Fatalf("expected think level high, got %q", think)
	}

	cancel()
	select {
	case err := <-runDone:
		if err != nil && err != context.Canceled {
			t.Fatalf("coordinator returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for coordinator shutdown")
	}
}

type fakeTelegramServer struct {
	Server               *httptest.Server
	mu                   sync.Mutex
	updates              []telegram.Update
	retainUpdates        bool
	rejectDuplicateEdits bool
	sentMessages         []recordedMessage
	editedMessages       []recordedMessage
	messageTextByID      map[int64]string
	nextMessageID        int64
}

type recordedMessage struct {
	ChatID    string
	Text      string
	MessageID int64
}

func newFakeTelegramServer(t *testing.T) *fakeTelegramServer {
	t.Helper()
	api := &fakeTelegramServer{
		nextMessageID:   500,
		messageTextByID: map[int64]string{},
	}
	api.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/getUpdates"):
			payload := decodePayload(t, r)
			offset := int64(payloadNumber(payload["offset"]))
			api.respond(w, map[string]any{"ok": true, "result": api.getUpdates(offset)})
		case strings.Contains(r.URL.Path, "/sendMessage"):
			payload := decodePayload(t, r)
			message := api.createMessage(payload, 0)
			api.mu.Lock()
			api.sentMessages = append(api.sentMessages, message)
			api.messageTextByID[message.MessageID] = message.Text
			api.mu.Unlock()
			api.respond(w, map[string]any{"ok": true, "result": map[string]any{
				"message_id": message.MessageID,
				"date":       1772766400,
				"text":       message.Text,
				"chat": map[string]any{
					"id":   payloadNumber(payload["chat_id"]),
					"type": "private",
				},
			}})
		case strings.Contains(r.URL.Path, "/editMessageText"):
			payload := decodePayload(t, r)
			messageID := int64(payloadNumber(payload["message_id"]))
			message := api.createMessage(payload, messageID)
			api.mu.Lock()
			if api.rejectDuplicateEdits && api.messageTextByID[message.MessageID] == message.Text {
				api.mu.Unlock()
				w.WriteHeader(http.StatusBadRequest)
				api.respond(w, map[string]any{
					"ok":          false,
					"error_code":  http.StatusBadRequest,
					"description": "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
				})
				return
			}
			api.editedMessages = append(api.editedMessages, message)
			api.messageTextByID[message.MessageID] = message.Text
			api.mu.Unlock()
			api.respond(w, map[string]any{"ok": true, "result": map[string]any{
				"message_id": message.MessageID,
				"date":       1772766400,
				"text":       message.Text,
				"chat": map[string]any{
					"id":   payloadNumber(payload["chat_id"]),
					"type": "private",
				},
			}})
		case strings.Contains(r.URL.Path, "/answerCallbackQuery"):
			api.respond(w, map[string]any{"ok": true, "result": true})
		case strings.Contains(r.URL.Path, "/getFile"):
			payload := decodePayload(t, r)
			api.respond(w, map[string]any{"ok": true, "result": map[string]any{
				"file_id":   payload["file_id"],
				"file_path": "fake.jpg",
			}})
		case strings.Contains(r.URL.Path, "/file/"):
			_, _ = w.Write([]byte{1, 2, 3})
		default:
			http.Error(w, "unsupported", http.StatusNotFound)
		}
	}))
	return api
}

func (f *fakeTelegramServer) Close() {
	f.Server.Close()
}

func (f *fakeTelegramServer) PushUpdate(update telegram.Update) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updates = append(f.updates, update)
}

func (f *fakeTelegramServer) SetRetainUpdates(value bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.retainUpdates = value
}

func (f *fakeTelegramServer) WaitForSentMessage(t *testing.T, text string, timeout time.Duration) recordedMessage {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		for _, message := range f.sentMessages {
			if strings.Contains(message.Text, text) {
				f.mu.Unlock()
				return message
			}
		}
		f.mu.Unlock()
		time.Sleep(100 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var seen []string
	for _, message := range f.sentMessages {
		seen = append(seen, message.Text)
	}
	t.Fatalf("timed out waiting for sent message containing %q; seen=%q", text, seen)
	return recordedMessage{}
}

func (f *fakeTelegramServer) WaitForEditedMessage(t *testing.T, text string, timeout time.Duration) recordedMessage {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		for _, message := range f.editedMessages {
			if strings.Contains(message.Text, text) {
				f.mu.Unlock()
				return message
			}
		}
		f.mu.Unlock()
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for edited message containing %q", text)
	return recordedMessage{}
}

func (f *fakeTelegramServer) HasSentText(text string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, message := range f.sentMessages {
		if strings.Contains(message.Text, text) {
			return true
		}
	}
	return false
}

func (f *fakeTelegramServer) getUpdates(offset int64) []telegram.Update {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.retainUpdates {
		var updates []telegram.Update
		for _, update := range f.updates {
			if update.UpdateID >= offset {
				updates = append(updates, update)
			}
		}
		return updates
	}

	updates := append([]telegram.Update(nil), f.updates...)
	f.updates = nil
	return updates
}

func (f *fakeTelegramServer) createMessage(payload map[string]any, explicitID int64) recordedMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	messageID := explicitID
	if messageID == 0 {
		messageID = f.nextMessageID
		f.nextMessageID++
	}
	return recordedMessage{
		ChatID:    fmt.Sprintf("%v", payload["chat_id"]),
		Text:      fmt.Sprintf("%v", payload["text"]),
		MessageID: messageID,
	}
}

func (f *fakeTelegramServer) respond(w http.ResponseWriter, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func textUpdate(updateID int64, text string) telegram.Update {
	return textUpdateWithMessageID(updateID, updateID, text)
}

func textUpdateInChat(updateID, messageID, chatID int64, text string) telegram.Update {
	return telegram.Update{
		UpdateID: updateID,
		Message: &telegram.Message{
			MessageID: messageID,
			Date:      1772766400 + updateID,
			Text:      text,
			Chat: telegram.Chat{
				ID:   chatID,
				Type: "private",
			},
			From: &telegram.User{ID: 1},
		},
	}
}

func textUpdateWithMessageID(updateID, messageID int64, text string) telegram.Update {
	return textUpdateInChat(updateID, messageID, 1, text)
}

func callbackUpdate(updateID, messageID int64, actionID string, approve bool) telegram.Update {
	prefix := "pd:"
	if approve {
		prefix = "pa:"
	}
	return callbackDataUpdate(updateID, messageID, prefix+actionID)
}

func callbackDataUpdate(updateID, messageID int64, data string) telegram.Update {
	return callbackDataUpdateInChat(updateID, 1, 1, messageID, data)
}

func callbackDataUpdateInChat(updateID, userID, chatID, messageID int64, data string) telegram.Update {
	return telegram.Update{
		UpdateID: updateID,
		CallbackQuery: &telegram.CallbackQuery{
			ID:   fmt.Sprintf("callback-%d", updateID),
			From: telegram.User{ID: userID},
			Data: data,
			Message: &telegram.Message{
				MessageID: messageID,
				Date:      1772766400 + updateID,
				Text:      "approval request",
				Chat: telegram.Chat{
					ID:   chatID,
					Type: "private",
				},
				From: &telegram.User{ID: 0},
			},
		},
	}
}

func writeFakeCodex(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-codex.sh")
	script := `#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
trap 'exit 0' INT
if [[ "${prompt}" == *"You are operating in plan mode."* ]]; then
  echo '{"type":"thread.started","thread_id":"thread-live"}'
  sleep 0.05
  echo '{"type":"agent_message","message":"{\"summary\":\"Plan the implementation safely\",\"assumptions\":[\"Tests can be run locally\"],\"options\":[{\"title\":\"Minimal fix\",\"details\":\"Patch the failing path and run targeted tests\",\"recommended\":true},{\"title\":\"Broader refactor\",\"details\":\"Refactor the module before fixing the issue\",\"recommended\":false}]}"}'
  sleep 0.05
  exit 0
fi
if [[ "${prompt}" == *"The user selected an implementation option from plan mode."* ]]; then
  echo '{"type":"thread.started","thread_id":"thread-live"}'
  sleep 0.05
  echo '{"type":"agent_message","message":"Executed selected plan"}'
  sleep 0.05
  exit 0
fi
if [[ "${2:-}" == "resume" ]] || [[ "${prompt}" == *"Resume the previous task"* ]]; then
  echo '{"type":"thread.started","thread_id":"thread-live"}'
  sleep 0.05
  echo '{"type":"agent_message","message":"Approved answer"}'
  sleep 0.05
  exit 0
fi
echo '{"type":"thread.started","thread_id":"thread-live"}'
sleep 0.05
echo '{"type":"exec_approval_request","call_id":"call-1","command":["git","status"],"cwd":"/tmp","reason":"workspace_write_required"}'
sleep 30
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	return path
}

func writeStaticMessageCodex(t *testing.T, message string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-codex-static.sh")
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal static message: %v", err)
	}
	script := fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
echo '{"type":"thread.started","thread_id":"thread-live"}'
sleep 0.05
echo '{"type":"agent_message","message":%s}'
sleep 0.05
`, string(encoded))
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write static fake codex: %v", err)
	}
	return path
}

func decodePayload(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	defer r.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return payload
}

func payloadNumber(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}

func testLogger(t *testing.T) *slog.Logger {
	t.Helper()
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func waitForPendingAction(t *testing.T, storeHandle *store.Store, timeout time.Duration) storePendingAction {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		actions, err := storeHandle.ListPendingActions(context.Background(), true)
		if err != nil {
			t.Fatalf("list pending actions: %v", err)
		}
		if len(actions) > 0 {
			return storePendingAction(actions[0])
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("timed out waiting for pending action")
	return storePendingAction{}
}

func waitForCurrentSessionState(t *testing.T, storeHandle *store.Store, expected model.SessionRunState, timeout time.Duration) (*model.Session, error) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		session, err := storeHandle.GetCurrentSession(context.Background())
		if err != nil {
			return nil, err
		}
		if session != nil && session.RunState == expected {
			return session, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	session, err := storeHandle.GetCurrentSession(context.Background())
	if err != nil {
		return nil, err
	}
	return session, fmt.Errorf("timed out waiting for session state %s", expected)
}

func waitForSessionCount(t *testing.T, storeHandle *store.Store, expected int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		sessions, err := storeHandle.ListSessions(context.Background())
		if err != nil {
			t.Fatalf("list sessions: %v", err)
		}
		if len(sessions) == expected {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	sessions, err := storeHandle.ListSessions(context.Background())
	if err != nil {
		t.Fatalf("list sessions after timeout: %v", err)
	}
	t.Fatalf("timed out waiting for %d sessions; got %d", expected, len(sessions))
}

func waitForCurrentSessionID(t *testing.T, storeHandle *store.Store, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		sessionID, err := storeHandle.GetCurrentSessionID(context.Background())
		if err != nil {
			t.Fatalf("get current session id: %v", err)
		}
		if sessionID != "" {
			return sessionID
		}
		time.Sleep(50 * time.Millisecond)
	}
	sessionID, err := storeHandle.GetCurrentSessionID(context.Background())
	if err != nil {
		t.Fatalf("get current session id after timeout: %v", err)
	}
	t.Fatalf("timed out waiting for current session id; got %q", sessionID)
	return ""
}

func waitForCurrentSessionIDValue(t *testing.T, storeHandle *store.Store, expected string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		sessionID, err := storeHandle.GetCurrentSessionID(context.Background())
		if err != nil {
			t.Fatalf("get current session id: %v", err)
		}
		if sessionID == expected {
			return sessionID
		}
		time.Sleep(50 * time.Millisecond)
	}
	sessionID, err := storeHandle.GetCurrentSessionID(context.Background())
	if err != nil {
		t.Fatalf("get current session id after timeout: %v", err)
	}
	t.Fatalf("timed out waiting for current session id %q; got %q", expected, sessionID)
	return ""
}

type storePendingAction = model.PendingAction
