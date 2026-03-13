package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	envAppHome               = "CODEX_TELEGRAM_BRIDGE_APP_HOME"
	envBotToken              = "CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN"
	envVerificationHash      = "CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH"
	envOwnerUserID           = "CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID"
	envOwnerChatID           = "CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID"
	envWorkspaceRoot         = "CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT"
	envLogLevel              = "CODEX_TELEGRAM_BRIDGE_LOG_LEVEL"
	envCodexExecutable       = "CODEX_TELEGRAM_BRIDGE_CODEX_EXECUTABLE"
	envCodexHome             = "CODEX_TELEGRAM_BRIDGE_CODEX_HOME"
	envApprovalPolicy        = "CODEX_TELEGRAM_BRIDGE_CODEX_APPROVAL_POLICY"
	envSandboxMode           = "CODEX_TELEGRAM_BRIDGE_CODEX_SANDBOX_MODE"
	envResolvedApprovalDays  = "CODEX_TELEGRAM_BRIDGE_RESOLVED_APPROVAL_RETENTION_DAYS"
	envExpiredApprovalDays   = "CODEX_TELEGRAM_BRIDGE_EXPIRED_APPROVAL_RETENTION_DAYS"
	envMaxAuditRows          = "CODEX_TELEGRAM_BRIDGE_MAX_AUDIT_ROWS"
	defaultApprovalPolicy    = "never"
	defaultSandboxMode       = "danger-full-access"
	defaultResolvedRetention = 7
	defaultExpiredRetention  = 1
	defaultMaxAuditRows      = 1000
)

type Config struct {
	AppHome                       string
	DatabasePath                  string
	LogFilePath                   string
	PIDFilePath                   string
	StateFilePath                 string
	TempDir                       string
	CodexHome                     string
	TelegramBotToken              string
	VerificationPasswordHash      string
	OwnerUserID                   string
	OwnerChatID                   string
	DefaultWorkspaceRoot          string
	LogLevel                      string
	CodexExecutable               string
	CodexApprovalPolicy           string
	CodexSandboxMode              string
	ResolvedApprovalRetentionDays int
	ExpiredApprovalRetentionDays  int
	MaxAuditRows                  int
}

func Load(explicitEnvFile string) (Config, error) {
	if explicitEnvFile != "" {
		if err := loadEnvFile(explicitEnvFile, true); err != nil {
			return Config{}, err
		}
	} else if defaultEnvFile, err := DefaultEnvFilePath(); err == nil {
		if _, statErr := os.Stat(defaultEnvFile); statErr == nil {
			if err := loadEnvFile(defaultEnvFile, false); err != nil {
				return Config{}, err
			}
		}
	}

	appHome := strings.TrimSpace(os.Getenv(envAppHome))
	if appHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Config{}, fmt.Errorf("resolve home dir: %w", err)
		}
		appHome = filepath.Join(home, ".local", "share", "codex-telegram-bridge")
	}

	codexHome := strings.TrimSpace(os.Getenv(envCodexHome))
	if codexHome == "" {
		codexHome = strings.TrimSpace(os.Getenv("CODEX_HOME"))
	}
	if codexHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Config{}, fmt.Errorf("resolve codex home dir: %w", err)
		}
		codexHome = filepath.Join(home, ".codex")
	}

	cfg := Config{
		AppHome:                       appHome,
		DatabasePath:                  filepath.Join(appHome, "bridge.db"),
		LogFilePath:                   filepath.Join(appHome, "bridge.log"),
		PIDFilePath:                   filepath.Join(appHome, "bridge.pid"),
		StateFilePath:                 filepath.Join(appHome, "bridge-state.json"),
		TempDir:                       filepath.Join(appHome, "tmp"),
		CodexHome:                     codexHome,
		TelegramBotToken:              strings.TrimSpace(os.Getenv(envBotToken)),
		VerificationPasswordHash:      strings.TrimSpace(os.Getenv(envVerificationHash)),
		OwnerUserID:                   strings.TrimSpace(os.Getenv(envOwnerUserID)),
		OwnerChatID:                   strings.TrimSpace(os.Getenv(envOwnerChatID)),
		DefaultWorkspaceRoot:          strings.TrimSpace(os.Getenv(envWorkspaceRoot)),
		LogLevel:                      firstNonEmpty(strings.TrimSpace(os.Getenv(envLogLevel)), "info"),
		CodexExecutable:               firstNonEmpty(strings.TrimSpace(os.Getenv(envCodexExecutable)), "codex"),
		CodexApprovalPolicy:           firstNonEmpty(strings.TrimSpace(os.Getenv(envApprovalPolicy)), defaultApprovalPolicy),
		CodexSandboxMode:              firstNonEmpty(strings.TrimSpace(os.Getenv(envSandboxMode)), defaultSandboxMode),
		ResolvedApprovalRetentionDays: readIntEnv(envResolvedApprovalDays, defaultResolvedRetention),
		ExpiredApprovalRetentionDays:  readIntEnv(envExpiredApprovalDays, defaultExpiredRetention),
		MaxAuditRows:                  readIntEnv(envMaxAuditRows, defaultMaxAuditRows),
	}

	if cfg.TelegramBotToken == "" {
		return Config{}, fmt.Errorf("%s is required", envBotToken)
	}
	if cfg.OwnerUserID == "" {
		return Config{}, fmt.Errorf("%s is required", envOwnerUserID)
	}
	if cfg.DefaultWorkspaceRoot == "" {
		return Config{}, fmt.Errorf("%s is required", envWorkspaceRoot)
	}

	return cfg, nil
}

func DefaultEnvFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, ".config", "codex-telegram-bridge", "config.env"), nil
}

func (c Config) EnsureDirectories() error {
	for _, path := range []string{c.AppHome, c.TempDir, c.CodexHome, filepath.Dir(c.LogFilePath), filepath.Dir(c.PIDFilePath), filepath.Dir(c.StateFilePath)} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", path, err)
		}
	}
	return nil
}

func loadEnvFile(path string, override bool) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open env file: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			return errors.New("invalid env line: missing =")
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if !override && strings.TrimSpace(os.Getenv(key)) != "" {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("set %s: %w", key, err)
		}
	}

	return scanner.Err()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func readIntEnv(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	var parsed int
	if _, err := fmt.Sscanf(raw, "%d", &parsed); err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
