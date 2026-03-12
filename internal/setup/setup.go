package setup

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/envfile"
	"codextelegrambridge/internal/policy"
)

const VerificationPasswordEnvVar = "CODEX_TELEGRAM_BRIDGE_SETUP_VERIFICATION_PASSWORD"

type Options struct {
	EnvFilePath   string
	Interactive   bool
	ShowHelp      bool
	BotToken      string
	OwnerUserID   string
	OwnerChatID   string
	WorkspaceRoot string
	AppHome       string
	CodexHome     string
	LogLevel      string
}

func HelpText() string {
	return strings.Join([]string{
		"Usage: codex-telegram-bridge setup [options]",
		"",
		"Options:",
		"  --config-env-file <path>   Write the generated config to a specific env file.",
		"  --env-file <path>          Write the generated config to a specific env file.",
		"  --non-interactive          Skip prompts and rely on flags, existing env values, and defaults.",
		"  --bot-token <token>        Set CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN.",
		"  --owner-user-id <id>       Set CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID.",
		"  --owner-chat-id <id>       Set CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID.",
		"  --workspace-root <path>    Set CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT.",
		"  --app-home <path>          Set CODEX_TELEGRAM_BRIDGE_APP_HOME.",
		"  --codex-home <path>        Set CODEX_TELEGRAM_BRIDGE_CODEX_HOME.",
		"  --log-level <level>        Set CODEX_TELEGRAM_BRIDGE_LOG_LEVEL.",
		"  --help                     Show this message.",
	}, "\n")
}

func ParseArgs(args []string) (Options, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Options{}, err
	}
	options := Options{
		EnvFilePath: filepath.Join(home, ".config", "codex-telegram-bridge", "config.env"),
		Interactive: true,
	}
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--env-file", "--config-env-file":
			index++
			options.EnvFilePath, err = readValue(args, index)
		case "--non-interactive":
			options.Interactive = false
		case "--bot-token":
			index++
			options.BotToken, err = readValue(args, index)
		case "--owner-user-id":
			index++
			options.OwnerUserID, err = readValue(args, index)
		case "--owner-chat-id":
			index++
			options.OwnerChatID, err = readValue(args, index)
		case "--workspace-root":
			index++
			options.WorkspaceRoot, err = readValue(args, index)
		case "--app-home":
			index++
			options.AppHome, err = readValue(args, index)
		case "--codex-home":
			index++
			options.CodexHome, err = readValue(args, index)
		case "--log-level":
			index++
			options.LogLevel, err = readValue(args, index)
		case "--help", "-h":
			options.ShowHelp = true
		default:
			return Options{}, fmt.Errorf("unsupported setup option: %s", args[index])
		}
		if err != nil {
			return Options{}, err
		}
	}
	options.EnvFilePath, _ = filepath.Abs(options.EnvFilePath)
	return options, nil
}

func Run(options Options) (config.Config, error) {
	existing, err := envfile.Read(options.EnvFilePath)
	if err != nil {
		return config.Config{}, err
	}
	values, err := resolveValues(existing, options)
	if err != nil {
		return config.Config{}, err
	}
	entries, err := buildEntries(existing, values)
	if err != nil {
		return config.Config{}, err
	}
	if err := os.MkdirAll(filepath.Dir(options.EnvFilePath), 0o700); err != nil {
		return config.Config{}, err
	}
	if err := os.MkdirAll(values["CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT"], 0o700); err != nil {
		return config.Config{}, err
	}
	if err := os.WriteFile(options.EnvFilePath, []byte(envfile.Render(entries)), 0o600); err != nil {
		return config.Config{}, err
	}
	cfg, err := config.Load(options.EnvFilePath)
	if err != nil {
		return config.Config{}, err
	}
	if err := cfg.EnsureDirectories(); err != nil {
		return config.Config{}, err
	}
	return cfg, nil
}

func resolveValues(existing map[string]string, options Options) (map[string]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	values := map[string]string{
		"CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT": firstNonEmpty(existing["CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT"], filepath.Join(home, "codex-workspaces", "main")),
		"CODEX_TELEGRAM_BRIDGE_APP_HOME":               firstNonEmpty(existing["CODEX_TELEGRAM_BRIDGE_APP_HOME"], filepath.Join(home, ".local", "share", "codex-telegram-bridge")),
		"CODEX_TELEGRAM_BRIDGE_CODEX_HOME":             firstNonEmpty(existing["CODEX_TELEGRAM_BRIDGE_CODEX_HOME"], existing["CODEX_HOME"], filepath.Join(home, ".codex")),
		"CODEX_TELEGRAM_BRIDGE_LOG_LEVEL":              firstNonEmpty(existing["CODEX_TELEGRAM_BRIDGE_LOG_LEVEL"], "info"),
		"CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN":     existing["CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN"],
		"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID": existing["CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID"],
		"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID": existing["CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID"],
	}

	applyOptionValues(values, options)

	password := strings.TrimSpace(os.Getenv(VerificationPasswordEnvVar))
	if options.Interactive {
		values = promptValues(values)
		password = promptSecret("Telegram verification password [hidden, press Enter to keep existing]: ")
	}
	if password != "" {
		hash, err := policy.HashPassword(password)
		if err != nil {
			return nil, err
		}
		values["CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH"] = hash
	} else if existingHash := existing["CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH"]; existingHash != "" {
		values["CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH"] = existingHash
	}

	required := []string{
		"CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN",
		"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID",
		"CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT",
	}
	for _, key := range required {
		if strings.TrimSpace(values[key]) == "" {
			return nil, fmt.Errorf("%s is required", key)
		}
	}
	return values, nil
}

func buildEntries(existing map[string]string, values map[string]string) ([][2]string, error) {
	entries := [][2]string{{"CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN", values["CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN"]}}
	if hash := strings.TrimSpace(values["CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH"]); hash != "" {
		entries = append(entries, [2]string{"CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH", hash})
	}
	entries = append(entries,
		[2]string{"CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT", filepath.Clean(values["CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT"])},
		[2]string{"CODEX_TELEGRAM_BRIDGE_APP_HOME", filepath.Clean(values["CODEX_TELEGRAM_BRIDGE_APP_HOME"])},
		[2]string{"CODEX_TELEGRAM_BRIDGE_CODEX_HOME", filepath.Clean(values["CODEX_TELEGRAM_BRIDGE_CODEX_HOME"])},
		[2]string{"CODEX_TELEGRAM_BRIDGE_LOG_LEVEL", values["CODEX_TELEGRAM_BRIDGE_LOG_LEVEL"]},
	)
	if value := strings.TrimSpace(values["CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID"]); value != "" {
		entries = append(entries, [2]string{"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID", value})
	}
	if value := strings.TrimSpace(values["CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID"]); value != "" {
		entries = append(entries, [2]string{"CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID", value})
	}
	sanitizedExisting := map[string]string{}
	for key, value := range existing {
		if key == "NODE_ENV" {
			continue
		}
		sanitizedExisting[key] = value
	}
	return envfile.MergeKnownEntries(sanitizedExisting, entries), nil
}

func applyOptionValues(values map[string]string, options Options) {
	assign := func(key, value string) {
		if strings.TrimSpace(value) != "" {
			values[key] = strings.TrimSpace(value)
		}
	}
	assign("CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN", options.BotToken)
	assign("CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID", options.OwnerUserID)
	assign("CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID", options.OwnerChatID)
	assign("CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT", options.WorkspaceRoot)
	assign("CODEX_TELEGRAM_BRIDGE_APP_HOME", options.AppHome)
	assign("CODEX_TELEGRAM_BRIDGE_CODEX_HOME", options.CodexHome)
	assign("CODEX_TELEGRAM_BRIDGE_LOG_LEVEL", options.LogLevel)
}

func promptValues(values map[string]string) map[string]string {
	reader := bufio.NewReader(os.Stdin)
	prompts := []struct {
		label string
		key   string
	}{
		{"Telegram bot token", "CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN"},
		{"Owner Telegram user ID", "CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID"},
		{"Owner Telegram chat ID", "CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID"},
		{"Workspace root", "CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT"},
		{"App home", "CODEX_TELEGRAM_BRIDGE_APP_HOME"},
		{"Codex home", "CODEX_TELEGRAM_BRIDGE_CODEX_HOME"},
		{"Log level", "CODEX_TELEGRAM_BRIDGE_LOG_LEVEL"},
	}
	for _, prompt := range prompts {
		fmt.Printf("%s [%s]: ", prompt.label, values[prompt.key])
		line, _ := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			values[prompt.key] = line
		}
	}
	return values
}

func promptSecret(label string) string {
	fmt.Print(label)
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	return strings.TrimSpace(line)
}

func readValue(args []string, index int) (string, error) {
	if index >= len(args) {
		return "", fmt.Errorf("missing value")
	}
	return args[index], nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}
