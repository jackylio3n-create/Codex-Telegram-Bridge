package doctor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/store"
	"codextelegrambridge/internal/telegram"
)

type CheckStatus string

const (
	StatusOK      CheckStatus = "ok"
	StatusWarning CheckStatus = "warning"
	StatusError   CheckStatus = "error"
	StatusSkipped CheckStatus = "skipped"
)

type Check struct {
	ID      string
	Label   string
	Status  CheckStatus
	Summary string
	Details []string
}

type Report struct {
	GeneratedAt time.Time
	Checks      []Check
}

func Run(ctx context.Context, cfg config.Config) Report {
	report := Report{
		GeneratedAt: time.Now().UTC(),
	}
	report.Checks = append(report.Checks, checkPaths(cfg))
	report.Checks = append(report.Checks, checkDaemon(cfg.PIDFilePath))
	report.Checks = append(report.Checks, checkStorage(ctx, cfg.DatabasePath))
	report.Checks = append(report.Checks, checkTelegram(ctx, cfg.TelegramBotToken))
	report.Checks = append(report.Checks, checkCodex(ctx, cfg.CodexExecutable))
	return report
}

func Render(report Report) string {
	lines := []string{
		"Diagnostics doctor report",
		"Generated at: " + report.GeneratedAt.Format(time.RFC3339),
		"",
	}
	var okCount, warningCount, errorCount, skippedCount int
	for _, check := range report.Checks {
		lines = append(lines, fmt.Sprintf("%s %s: %s", renderStatus(check.Status), check.Label, check.Summary))
		for _, detail := range check.Details {
			lines = append(lines, "  - "+detail)
		}
		switch check.Status {
		case StatusOK:
			okCount++
		case StatusWarning:
			warningCount++
		case StatusError:
			errorCount++
		case StatusSkipped:
			skippedCount++
		}
	}
	lines = append(lines, "")
	lines = append(lines, fmt.Sprintf("Summary: status=%s, ok=%d, warning=%d, error=%d, skipped=%d", summarizeStatus(errorCount, warningCount), okCount, warningCount, errorCount, skippedCount))
	return strings.Join(lines, "\n") + "\n"
}

func ExitCode(report Report) int {
	for _, check := range report.Checks {
		if check.Status == StatusError {
			return 1
		}
	}
	return 0
}

func checkPaths(cfg config.Config) Check {
	paths := []struct {
		label string
		value string
	}{
		{"app home", cfg.AppHome},
		{"codex home", cfg.CodexHome},
		{"workspace root", cfg.DefaultWorkspaceRoot},
	}
	var details []string
	status := StatusOK
	for _, entry := range paths {
		info, err := os.Stat(entry.value)
		if err != nil {
			status = StatusError
			details = append(details, fmt.Sprintf("%s: %v", entry.label, err))
			continue
		}
		if !info.IsDir() {
			status = StatusError
			details = append(details, fmt.Sprintf("%s: not a directory", entry.label))
		}
	}
	summary := "Managed directories are accessible."
	if status == StatusError {
		summary = "One or more required directories are missing or inaccessible."
	}
	return Check{ID: "paths", Label: "managed directories", Status: status, Summary: summary, Details: details}
}

func checkDaemon(pidFilePath string) Check {
	raw, err := os.ReadFile(pidFilePath)
	if err != nil {
		if os.IsNotExist(err) {
			return Check{ID: "daemon", Label: "daemon runtime", Status: StatusWarning, Summary: "Bridge daemon is not running.", Details: []string{"No PID file was found."}}
		}
		return Check{ID: "daemon", Label: "daemon runtime", Status: StatusError, Summary: "Unable to read PID file.", Details: []string{err.Error()}}
	}
	var pid int
	if _, err := fmt.Sscanf(string(raw), "%d", &pid); err != nil {
		return Check{ID: "daemon", Label: "daemon runtime", Status: StatusWarning, Summary: "PID file is invalid.", Details: []string{strings.TrimSpace(string(raw))}}
	}
	process, err := os.FindProcess(pid)
	if err != nil || process.Signal(syscall.Signal(0)) != nil {
		return Check{ID: "daemon", Label: "daemon runtime", Status: StatusWarning, Summary: fmt.Sprintf("PID %d is not running.", pid), Details: []string{"The PID file exists but the process is gone."}}
	}
	return Check{ID: "daemon", Label: "daemon runtime", Status: StatusOK, Summary: fmt.Sprintf("Bridge daemon is running (pid %d).", pid), Details: []string{"PID file is present and the process is alive."}}
}

func checkStorage(ctx context.Context, databasePath string) Check {
	storeHandle, err := store.Open(databasePath)
	if err != nil {
		return Check{ID: "storage", Label: "storage", Status: StatusError, Summary: "SQLite store could not be opened.", Details: []string{err.Error()}}
	}
	defer storeHandle.Close()
	if err := storeHandle.SetOwnerChatID(ctx, "doctor-probe"); err != nil {
		return Check{ID: "storage", Label: "storage", Status: StatusError, Summary: "SQLite store is not writable.", Details: []string{err.Error()}}
	}
	_ = storeHandle.SetOwnerChatID(ctx, "")
	return Check{ID: "storage", Label: "storage", Status: StatusOK, Summary: fmt.Sprintf("SQLite store is readable and writable at %s.", databasePath), Details: nil}
}

func checkTelegram(ctx context.Context, token string) Check {
	client := telegram.NewClient(token)
	if _, err := client.GetUpdates(ctx, 0, 0); err != nil {
		return Check{ID: "telegram", Label: "telegram runtime", Status: StatusError, Summary: "Telegram token probe failed.", Details: []string{err.Error()}}
	}
	return Check{ID: "telegram", Label: "telegram runtime", Status: StatusOK, Summary: "Telegram token probe succeeded.", Details: []string{"Validated via getUpdates with a zero-timeout health probe."}}
}

func checkCodex(ctx context.Context, executable string) Check {
	cmd := exec.CommandContext(ctx, executable, "login", "status")
	output, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(output))
	if err != nil {
		if text == "" {
			text = err.Error()
		}
		return Check{ID: "codex", Label: "codex runtime", Status: StatusError, Summary: "Codex CLI is not available or not logged in.", Details: []string{text}}
	}
	if !strings.Contains(strings.ToLower(text), "logged in") {
		return Check{ID: "codex", Label: "codex runtime", Status: StatusError, Summary: "Codex CLI is available but not logged in.", Details: []string{text}}
	}
	return Check{ID: "codex", Label: "codex runtime", Status: StatusOK, Summary: "Codex CLI is available and logged in.", Details: []string{text}}
}

func renderStatus(status CheckStatus) string {
	switch status {
	case StatusOK:
		return "[OK]"
	case StatusWarning:
		return "[WARN]"
	case StatusError:
		return "[FAIL]"
	default:
		return "[SKIP]"
	}
}

func summarizeStatus(errorCount, warningCount int) string {
	if errorCount > 0 {
		return "error"
	}
	if warningCount > 0 {
		return "warning"
	}
	return "ok"
}
