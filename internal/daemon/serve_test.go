package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/telegram"
)

func TestServeWritesPIDLogAndState(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	workspaceRoot := filepath.Join(tempRoot, "workspace")
	if err := os.MkdirAll(workspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/getUpdates") {
			http.Error(w, "unsupported", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"result": []any{},
		})
	}))
	defer server.Close()

	cfg := config.Config{
		AppHome:              filepath.Join(tempRoot, "app"),
		DatabasePath:         filepath.Join(tempRoot, "app", "bridge.db"),
		LogFilePath:          filepath.Join(tempRoot, "app", "bridge.log"),
		PIDFilePath:          filepath.Join(tempRoot, "app", "bridge.pid"),
		StateFilePath:        filepath.Join(tempRoot, "app", "bridge-state.json"),
		TempDir:              filepath.Join(tempRoot, "app", "tmp"),
		CodexHome:            filepath.Join(tempRoot, ".codex"),
		TelegramBotToken:     "telegram-token",
		OwnerUserID:          "1",
		DefaultWorkspaceRoot: workspaceRoot,
		LogLevel:             "info",
		CodexExecutable:      "/bin/true",
	}

	client := telegram.NewClientWithOptions(telegram.Options{
		Token:       cfg.TelegramBotToken,
		HTTPClient:  server.Client(),
		BaseURL:     server.URL + "/bot" + cfg.TelegramBotToken,
		FileBaseURL: server.URL + "/file/bot" + cfg.TelegramBotToken,
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, cfg, Options{TelegramClient: client})
	}()

	waitForCondition(t, 5*time.Second, func() bool {
		state, err := ReadRuntimeState(cfg.StateFilePath)
		return err == nil && state != nil && state.Status == StatusRunning
	})

	pid, err := ReadPIDFile(cfg.PIDFilePath)
	if err != nil {
		t.Fatalf("read pid file: %v", err)
	}
	if pid == 0 {
		t.Fatal("expected pid file to contain a pid")
	}

	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for serve to stop")
	}

	state, err := ReadRuntimeState(cfg.StateFilePath)
	if err != nil {
		t.Fatalf("read final runtime state: %v", err)
	}
	if state == nil || state.Status != StatusStopped {
		t.Fatalf("unexpected final state: %#v", state)
	}

	pid, err = ReadPIDFile(cfg.PIDFilePath)
	if err != nil {
		t.Fatalf("read pid after stop: %v", err)
	}
	if pid != 0 {
		t.Fatalf("expected pid file to be removed, got %d", pid)
	}

	logBody, err := os.ReadFile(cfg.LogFilePath)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if !strings.Contains(string(logBody), "bridge daemon starting") {
		t.Fatalf("unexpected log body: %q", string(logBody))
	}
}

func waitForCondition(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}
