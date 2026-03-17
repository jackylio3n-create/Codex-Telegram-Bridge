package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"codextelegrambridge/internal/config"
)

func TestCleanupBridgeRuntimeFilesRemovesStaleArtifacts(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	cfg := config.Config{
		AppHome: filepath.Join(root, "app"),
		TempDir: filepath.Join(root, "app", "tmp"),
	}
	if err := os.MkdirAll(cfg.TempDir, 0o700); err != nil {
		t.Fatalf("mkdir temp dir: %v", err)
	}
	oldTemp := filepath.Join(cfg.TempDir, "old-image.jpg")
	newTemp := filepath.Join(cfg.TempDir, "new-image.jpg")
	oldState := filepath.Join(cfg.AppHome, ".bridge-state-old.json")
	newState := filepath.Join(cfg.AppHome, ".bridge-state-new.json")
	for _, path := range []string{oldTemp, newTemp, oldState, newState} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	oldTime := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(oldTemp, oldTime, oldTime); err != nil {
		t.Fatalf("chtimes old temp: %v", err)
	}
	if err := os.Chtimes(oldState, oldTime, oldTime); err != nil {
		t.Fatalf("chtimes old state: %v", err)
	}

	if err := cleanupBridgeRuntimeFiles(cfg, time.Now()); err != nil {
		t.Fatalf("cleanup runtime files: %v", err)
	}

	if _, err := os.Stat(oldTemp); !os.IsNotExist(err) {
		t.Fatalf("expected old temp file to be deleted, err=%v", err)
	}
	if _, err := os.Stat(oldState); !os.IsNotExist(err) {
		t.Fatalf("expected old state temp file to be deleted, err=%v", err)
	}
	if _, err := os.Stat(newTemp); err != nil {
		t.Fatalf("expected new temp file to remain: %v", err)
	}
	if _, err := os.Stat(newState); err != nil {
		t.Fatalf("expected new state temp file to remain: %v", err)
	}
}

func TestCleanupCodexArtifactsPrunesAndRotates(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	sessionDir := filepath.Join(codexHome, "sessions", "2026", "03", "13")
	logDir := filepath.Join(codexHome, "log")
	snapshotDir := filepath.Join(codexHome, "shell_snapshots")
	for _, path := range []string{sessionDir, logDir, snapshotDir} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
	}

	oldSession := filepath.Join(sessionDir, "old.jsonl")
	newSession := filepath.Join(sessionDir, "new.jsonl")
	oldSnapshot := filepath.Join(snapshotDir, "old.sh")
	newSnapshot := filepath.Join(snapshotDir, "new.sh")
	historyPath := filepath.Join(codexHome, "history.jsonl")
	logPath := filepath.Join(logDir, "codex-tui.log")
	for _, path := range []string{oldSession, newSession, oldSnapshot, newSnapshot} {
		if err := os.WriteFile(path, []byte("data\n"), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	if err := os.WriteFile(historyPath, []byte("1\n2\n3\n4\n5\n"), 0o600); err != nil {
		t.Fatalf("write history: %v", err)
	}
	if err := rotateStandaloneFile(logPath, codexLogMaxBytes, codexLogMaxBackups); err != nil && !os.IsNotExist(err) {
		t.Fatalf("precheck rotate log: %v", err)
	}
	if err := os.WriteFile(logPath, make([]byte, codexLogMaxBytes+1), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}

	oldTime := time.Now().Add(-30 * 24 * time.Hour)
	for _, path := range []string{oldSession, oldSnapshot} {
		if err := os.Chtimes(path, oldTime, oldTime); err != nil {
			t.Fatalf("chtimes %s: %v", path, err)
		}
	}

	if err := trimJSONLFile(historyPath, 6); err != nil {
		t.Fatalf("trim history: %v", err)
	}
	if err := cleanupCodexArtifacts(codexHome, time.Now()); err != nil {
		t.Fatalf("cleanup codex artifacts: %v", err)
	}

	if _, err := os.Stat(oldSession); !os.IsNotExist(err) {
		t.Fatalf("expected old session to be deleted, err=%v", err)
	}
	if _, err := os.Stat(oldSnapshot); !os.IsNotExist(err) {
		t.Fatalf("expected old snapshot to be deleted, err=%v", err)
	}
	if _, err := os.Stat(newSession); err != nil {
		t.Fatalf("expected new session to remain: %v", err)
	}
	if _, err := os.Stat(newSnapshot); err != nil {
		t.Fatalf("expected new snapshot to remain: %v", err)
	}
	body, err := os.ReadFile(historyPath)
	if err != nil {
		t.Fatalf("read trimmed history: %v", err)
	}
	if string(body) != "4\n5\n" {
		t.Fatalf("unexpected trimmed history: %q", string(body))
	}
	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Fatalf("expected rotated codex log backup: %v", err)
	}
}
