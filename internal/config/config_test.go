package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadUsesDefaultEnvFileWithoutOverridingShellEnv(t *testing.T) {
	t.Setenv(envBotToken, "")
	t.Setenv(envOwnerUserID, "")
	t.Setenv(envWorkspaceRoot, "")
	t.Setenv(envLogLevel, "debug")

	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)

	envDir := filepath.Join(homeDir, ".config", "codex-telegram-bridge")
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		t.Fatalf("mkdir env dir: %v", err)
	}

	envPath := filepath.Join(envDir, "config.env")
	envBody := []byte(
		"CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN=test-token\n" +
			"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID=12345\n" +
			"CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT=/tmp/workspace\n" +
			"CODEX_TELEGRAM_BRIDGE_LOG_LEVEL=info\n",
	)
	if err := os.WriteFile(envPath, envBody, 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.TelegramBotToken != "test-token" {
		t.Fatalf("unexpected bot token: %q", cfg.TelegramBotToken)
	}
	if cfg.OwnerUserID != "12345" {
		t.Fatalf("unexpected owner user id: %q", cfg.OwnerUserID)
	}
	if cfg.DefaultWorkspaceRoot != "/tmp/workspace" {
		t.Fatalf("unexpected workspace root: %q", cfg.DefaultWorkspaceRoot)
	}
	if cfg.LogLevel != "debug" {
		t.Fatalf("shell env should win over default env file, got %q", cfg.LogLevel)
	}
	if cfg.CodexApprovalPolicy != "never" {
		t.Fatalf("unexpected approval policy default: %q", cfg.CodexApprovalPolicy)
	}
	if cfg.CodexSandboxMode != "danger-full-access" {
		t.Fatalf("unexpected sandbox mode default: %q", cfg.CodexSandboxMode)
	}
}

func TestLoadReadsConfiguredRuntimePolicy(t *testing.T) {
	t.Setenv(envBotToken, "")
	t.Setenv(envOwnerUserID, "")
	t.Setenv(envWorkspaceRoot, "")

	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)

	envDir := filepath.Join(homeDir, ".config", "codex-telegram-bridge")
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		t.Fatalf("mkdir env dir: %v", err)
	}

	envPath := filepath.Join(envDir, "config.env")
	envBody := []byte(
		"CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN=test-token\n" +
			"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID=12345\n" +
			"CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT=/tmp/workspace\n" +
			"CODEX_TELEGRAM_BRIDGE_CODEX_APPROVAL_POLICY=on-request\n" +
			"CODEX_TELEGRAM_BRIDGE_CODEX_SANDBOX_MODE=workspace-write\n",
	)
	if err := os.WriteFile(envPath, envBody, 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.CodexApprovalPolicy != "on-request" {
		t.Fatalf("unexpected approval policy: %q", cfg.CodexApprovalPolicy)
	}
	if cfg.CodexSandboxMode != "workspace-write" {
		t.Fatalf("unexpected sandbox mode: %q", cfg.CodexSandboxMode)
	}
}
