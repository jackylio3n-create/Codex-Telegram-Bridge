package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunHelp(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), &stdout, &stderr, nil)
	if code != 0 {
		t.Fatalf("unexpected exit code: %d", code)
	}
	if !strings.Contains(stdout.String(), "Codex Telegram Bridge daemon CLI") {
		t.Fatalf("unexpected help output: %q", stdout.String())
	}
}

func TestRunUnknownCommandPrintsHelp(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), &stdout, &stderr, []string{"nope"})
	if code != 1 {
		t.Fatalf("unexpected exit code: %d", code)
	}
	if !strings.Contains(stdout.String(), "Commands:") {
		t.Fatalf("unexpected help output: %q", stdout.String())
	}
}

func TestRunLogsRejectsInvalidLineCount(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	writeEnvFile(t, homeDir)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), &stdout, &stderr, []string{"logs", "zero"})
	if code != 1 {
		t.Fatalf("unexpected exit code: %d", code)
	}
	if !strings.Contains(stderr.String(), "invalid line count") {
		t.Fatalf("unexpected stderr: %q", stderr.String())
	}
}

func writeEnvFile(t *testing.T, homeDir string) {
	t.Helper()

	envDir := filepath.Join(homeDir, ".config", "codex-telegram-bridge")
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		t.Fatalf("mkdir env dir: %v", err)
	}
	workspaceRoot := filepath.Join(homeDir, "workspace")
	if err := os.MkdirAll(workspaceRoot, 0o700); err != nil {
		t.Fatalf("mkdir workspace root: %v", err)
	}
	envPath := filepath.Join(envDir, "config.env")
	body := strings.Join([]string{
		"CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN=test-token",
		"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID=1",
		"CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT=" + workspaceRoot,
		"",
	}, "\n")
	if err := os.WriteFile(envPath, []byte(body), 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}
}
