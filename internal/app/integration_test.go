package app

import (
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

	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/model"
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

	session, err := storeHandle.GetCurrentSession(context.Background())
	if err != nil {
		t.Fatalf("get current session: %v", err)
	}
	if session == nil || string(session.RunState) != "idle" {
		t.Fatalf("unexpected session state: %#v", session)
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

type fakeTelegramServer struct {
	Server         *httptest.Server
	mu             sync.Mutex
	updates        []telegram.Update
	sentMessages   []recordedMessage
	editedMessages []recordedMessage
	nextMessageID  int64
}

type recordedMessage struct {
	ChatID    string
	Text      string
	MessageID int64
}

func newFakeTelegramServer(t *testing.T) *fakeTelegramServer {
	t.Helper()
	api := &fakeTelegramServer{nextMessageID: 500}
	api.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/getUpdates"):
			api.respond(w, map[string]any{"ok": true, "result": api.popUpdates()})
		case strings.Contains(r.URL.Path, "/sendMessage"):
			payload := decodePayload(t, r)
			message := api.createMessage(payload, 0)
			api.mu.Lock()
			api.sentMessages = append(api.sentMessages, message)
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
			api.editedMessages = append(api.editedMessages, message)
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

func (f *fakeTelegramServer) popUpdates() []telegram.Update {
	f.mu.Lock()
	defer f.mu.Unlock()
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
	return telegram.Update{
		UpdateID: updateID,
		Message: &telegram.Message{
			MessageID: updateID,
			Date:      1772766400 + updateID,
			Text:      text,
			Chat: telegram.Chat{
				ID:   1,
				Type: "private",
			},
			From: &telegram.User{ID: 1},
		},
	}
}

func callbackUpdate(updateID, messageID int64, actionID string, approve bool) telegram.Update {
	prefix := "pd:"
	if approve {
		prefix = "pa:"
	}
	return telegram.Update{
		UpdateID: updateID,
		CallbackQuery: &telegram.CallbackQuery{
			ID:   fmt.Sprintf("callback-%d", updateID),
			From: telegram.User{ID: 1},
			Data: prefix + actionID,
			Message: &telegram.Message{
				MessageID: messageID,
				Date:      1772766400 + updateID,
				Text:      "approval request",
				Chat: telegram.Chat{
					ID:   1,
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
if [[ "${2:-}" == "resume" ]] || [[ "${prompt}" == *"Resume the previous task"* ]]; then
  echo '{"type":"thread.started","thread_id":"thread-live"}'
  echo '{"type":"agent_message","message":"Approved answer"}'
  exit 0
fi
echo '{"type":"thread.started","thread_id":"thread-live"}'
echo '{"type":"exec_approval_request","call_id":"call-1","command":["git","status"],"cwd":"/tmp","reason":"workspace_write_required"}'
sleep 30
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
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

type storePendingAction = model.PendingAction
