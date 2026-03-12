package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type RuntimeStatus string

const (
	StatusStarting RuntimeStatus = "starting"
	StatusRunning  RuntimeStatus = "running"
	StatusStopping RuntimeStatus = "stopping"
	StatusStopped  RuntimeStatus = "stopped"
	StatusError    RuntimeStatus = "error"
)

type RuntimeState struct {
	Version              int           `json:"version"`
	Phase                string        `json:"phase"`
	Status               RuntimeStatus `json:"status"`
	UpdatedAt            string        `json:"updated_at"`
	StartedAt            string        `json:"started_at,omitempty"`
	PID                  *int          `json:"pid,omitempty"`
	LogFilePath          string        `json:"log_file_path"`
	DatabaseFilePath     string        `json:"database_file_path"`
	LastPollAt           string        `json:"last_poll_at,omitempty"`
	LastSuccessfulPollAt string        `json:"last_successful_poll_at,omitempty"`
	LastFailedPollAt     string        `json:"last_failed_poll_at,omitempty"`
	LastPollError        string        `json:"last_poll_error,omitempty"`
	PreviousOffset       *int64        `json:"previous_offset,omitempty"`
	CurrentOffset        *int64        `json:"current_offset,omitempty"`
	ActiveRunCount       int           `json:"active_run_count"`
	ActiveSessionCount   int           `json:"active_session_count"`
	LastEvent            string        `json:"last_event,omitempty"`
}

func ReadRuntimeState(path string) (*RuntimeState, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	var state RuntimeState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, nil
	}
	if state.Version != 1 || state.Phase != "daemon" {
		return nil, nil
	}
	return &state, nil
}

func WriteRuntimeState(path string, state RuntimeState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')

	tempFile, err := os.CreateTemp(filepath.Dir(path), ".bridge-state-*.json")
	if err != nil {
		return err
	}
	tempPath := tempFile.Name()
	if _, err := tempFile.Write(body); err != nil {
		tempFile.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := tempFile.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Chmod(tempPath, 0o600); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return os.Rename(tempPath, path)
}

func ReadPIDFile(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	value, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || value <= 0 {
		return 0, nil
	}
	return value, nil
}

func WritePIDFile(path string, pid int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strconv.Itoa(pid)+"\n"), 0o600)
}

func RemovePIDFile(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func IsProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func TailFile(path string, lineCount int) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		if line != "" {
			filtered = append(filtered, line)
		}
	}
	if lineCount >= len(filtered) {
		return filtered, nil
	}
	return filtered[len(filtered)-lineCount:], nil
}

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}
