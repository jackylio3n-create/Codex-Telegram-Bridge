package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/daemon"
	"codextelegrambridge/internal/doctor"
	"codextelegrambridge/internal/setup"
)

const helpText = `Codex Telegram Bridge daemon CLI

Commands:
  help     Show this message.
  setup    Write the bridge env file for local deployment.
  serve    Run the bridge in the foreground.
  doctor   Run configuration, storage, Telegram, and Codex diagnostics.
  status   Show daemon PID, runtime state, and storage paths.
  logs     Print the last 40 lines from the bridge log file.

Global options:
  --config-env-file <path>  Load configuration from a specific env file.
  --env-file <path>         Alias for --config-env-file.
`

func Run(ctx context.Context, stdout, stderr io.Writer, argv []string) int {
	code, err := run(ctx, stdout, stderr, argv)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	return code
}

func run(ctx context.Context, stdout, stderr io.Writer, argv []string) (int, error) {
	command, args, envFilePath, err := parseMainArgs(argv)
	if err != nil {
		return 1, err
	}

	switch command {
	case "", "help", "--help", "-h":
		_, _ = fmt.Fprint(stdout, helpText)
		return 0, nil
	case "setup":
		return runSetup(stdout, args, envFilePath)
	case "serve", "doctor", "status", "logs":
	default:
		_, _ = fmt.Fprint(stdout, helpText)
		return 1, nil
	}

	cfg, err := config.Load(envFilePath)
	if err != nil {
		return 1, err
	}

	switch command {
	case "serve":
		return runServe(ctx, cfg)
	case "doctor":
		report := doctor.Run(ctx, cfg)
		_, _ = io.WriteString(stdout, doctor.Render(report))
		return doctor.ExitCode(report), nil
	case "status":
		return runStatus(stdout, cfg)
	case "logs":
		return runLogs(stdout, cfg, args)
	default:
		_, _ = fmt.Fprint(stdout, helpText)
		return 1, nil
	}
}

func runSetup(stdout io.Writer, argv []string, envFilePath string) (int, error) {
	args := argv
	if envFilePath != "" {
		args = append([]string{"--config-env-file", envFilePath}, args...)
	}
	options, err := setup.ParseArgs(args)
	if err != nil {
		return 1, err
	}
	if options.ShowHelp {
		_, _ = fmt.Fprint(stdout, setup.HelpText())
		return 0, nil
	}
	if _, err := setup.Run(options); err != nil {
		return 1, err
	}
	_, _ = fmt.Fprintf(stdout, "Wrote config to %s\n", options.EnvFilePath)
	return 0, nil
}

func runServe(ctx context.Context, cfg config.Config) (int, error) {
	if err := daemon.Serve(ctx, cfg, daemon.Options{}); err != nil {
		return 1, err
	}
	return 0, nil
}

func runStatus(stdout io.Writer, cfg config.Config) (int, error) {
	pid, err := daemon.ReadPIDFile(cfg.PIDFilePath)
	if err != nil {
		return 1, err
	}
	state, err := daemon.ReadRuntimeState(cfg.StateFilePath)
	if err != nil {
		return 1, err
	}

	running := pid != 0 && daemon.IsProcessRunning(pid)
	_, _ = fmt.Fprintf(stdout, "Daemon: %s\n", map[bool]string{true: "running", false: "stopped"}[running])
	_, _ = fmt.Fprintf(stdout, "PID: %s\n", valueOrNone(pid))
	_, _ = fmt.Fprintf(stdout, "State file: %s\n", cfg.StateFilePath)
	_, _ = fmt.Fprintf(stdout, "Log file: %s\n", cfg.LogFilePath)
	_, _ = fmt.Fprintf(stdout, "Database: %s\n", cfg.DatabasePath)

	if state == nil {
		_, _ = fmt.Fprintln(stdout, "Runtime state: missing")
		if running {
			return 0, nil
		}
		return 1, nil
	}

	_, _ = fmt.Fprintf(stdout, "Runtime status: %s\n", state.Status)
	_, _ = fmt.Fprintf(stdout, "Started at: %s\n", emptyFallback(state.StartedAt, "unknown"))
	_, _ = fmt.Fprintf(stdout, "Active runs: %d\n", state.ActiveRunCount)
	_, _ = fmt.Fprintf(stdout, "Active sessions: %d\n", state.ActiveSessionCount)
	_, _ = fmt.Fprintf(stdout, "Last poll: %s\n", emptyFallback(state.LastPollAt, "never"))
	_, _ = fmt.Fprintf(stdout, "Last successful poll: %s\n", emptyFallback(state.LastSuccessfulPollAt, "never"))
	_, _ = fmt.Fprintf(stdout, "Last failed poll: %s\n", emptyFallback(state.LastFailedPollAt, "never"))
	_, _ = fmt.Fprintf(stdout, "Offset: %s -> %s\n", int64ValueOrUnknown(state.PreviousOffset), int64ValueOrUnknown(state.CurrentOffset))
	_, _ = fmt.Fprintf(stdout, "Last event: %s\n", emptyFallback(state.LastEvent, "none"))
	if strings.TrimSpace(state.LastPollError) != "" {
		_, _ = fmt.Fprintf(stdout, "Last poll error: %s\n", state.LastPollError)
	}
	if running {
		return 0, nil
	}
	return 1, nil
}

func runLogs(stdout io.Writer, cfg config.Config, argv []string) (int, error) {
	lineCount := 40
	if len(argv) > 0 {
		var parsed int
		if _, err := fmt.Sscanf(argv[0], "%d", &parsed); err != nil || parsed <= 0 {
			return 1, errors.New(`invalid line count. Use "logs" or "logs <positive_number>"`)
		}
		lineCount = parsed
	}

	lines, err := daemon.TailFile(cfg.LogFilePath, lineCount)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			_, _ = fmt.Fprintf(stdout, "No log file found at %s\n", cfg.LogFilePath)
			return 0, nil
		}
		return 1, err
	}

	_, _ = fmt.Fprintf(stdout, "Showing last %d log lines from %s\n", len(lines), cfg.LogFilePath)
	if len(lines) > 0 {
		_, _ = fmt.Fprintln(stdout, strings.Join(lines, "\n"))
	}
	return 0, nil
}

func parseMainArgs(argv []string) (command string, args []string, envFilePath string, err error) {
	filtered := make([]string, 0, len(argv))
	for index := 0; index < len(argv); index++ {
		switch argv[index] {
		case "--config-env-file", "--env-file":
			index++
			if index >= len(argv) {
				return "", nil, "", fmt.Errorf("missing value for %s", argv[index-1])
			}
			envFilePath = argv[index]
		default:
			filtered = append(filtered, argv[index])
		}
	}
	if len(filtered) == 0 {
		return "help", nil, envFilePath, nil
	}
	return filtered[0], filtered[1:], envFilePath, nil
}

func valueOrNone(value int) string {
	if value == 0 {
		return "none"
	}
	return fmt.Sprintf("%d", value)
}

func int64ValueOrUnknown(value *int64) string {
	if value == nil {
		return "?"
	}
	return fmt.Sprintf("%d", *value)
}

func emptyFallback(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
