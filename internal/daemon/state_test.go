package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeStateRoundTrip(t *testing.T) {
	t.Parallel()

	statePath := filepath.Join(t.TempDir(), "bridge-state.json")
	pid := 42
	offset := int64(9)
	state := RuntimeState{
		Version:            1,
		Phase:              "daemon",
		Status:             StatusRunning,
		UpdatedAt:          nowRFC3339(),
		StartedAt:          nowRFC3339(),
		PID:                &pid,
		LogFilePath:        "/tmp/bridge.log",
		DatabaseFilePath:   "/tmp/bridge.db",
		PreviousOffset:     &offset,
		CurrentOffset:      &offset,
		ActiveRunCount:     1,
		ActiveSessionCount: 2,
		LastEvent:          "test",
	}

	if err := WriteRuntimeState(statePath, state); err != nil {
		t.Fatalf("write runtime state: %v", err)
	}

	loaded, err := ReadRuntimeState(statePath)
	if err != nil {
		t.Fatalf("read runtime state: %v", err)
	}
	if loaded == nil {
		t.Fatal("expected runtime state")
	}
	if loaded.Status != StatusRunning {
		t.Fatalf("unexpected status: %q", loaded.Status)
	}
	if loaded.ActiveSessionCount != 2 {
		t.Fatalf("unexpected active session count: %d", loaded.ActiveSessionCount)
	}
}

func TestReadRuntimeStateIgnoresInvalidJSON(t *testing.T) {
	t.Parallel()

	statePath := filepath.Join(t.TempDir(), "bridge-state.json")
	if err := os.WriteFile(statePath, []byte("{not-json"), 0o600); err != nil {
		t.Fatalf("write invalid state: %v", err)
	}

	loaded, err := ReadRuntimeState(statePath)
	if err != nil {
		t.Fatalf("read runtime state: %v", err)
	}
	if loaded != nil {
		t.Fatalf("expected nil state, got %#v", loaded)
	}
}

func TestPIDFileRoundTrip(t *testing.T) {
	t.Parallel()

	pidPath := filepath.Join(t.TempDir(), "bridge.pid")
	if err := WritePIDFile(pidPath, 123); err != nil {
		t.Fatalf("write pid file: %v", err)
	}
	pid, err := ReadPIDFile(pidPath)
	if err != nil {
		t.Fatalf("read pid file: %v", err)
	}
	if pid != 123 {
		t.Fatalf("unexpected pid: %d", pid)
	}
	if err := RemovePIDFile(pidPath); err != nil {
		t.Fatalf("remove pid file: %v", err)
	}
	pid, err = ReadPIDFile(pidPath)
	if err != nil {
		t.Fatalf("read pid after remove: %v", err)
	}
	if pid != 0 {
		t.Fatalf("expected no pid after remove, got %d", pid)
	}
}

func TestTailFileReturnsLastLines(t *testing.T) {
	t.Parallel()

	logPath := filepath.Join(t.TempDir(), "bridge.log")
	if err := os.WriteFile(logPath, []byte(strings.Join([]string{"a", "b", "c", "d", ""}, "\n")), 0o600); err != nil {
		t.Fatalf("write log file: %v", err)
	}

	lines, err := TailFile(logPath, 2)
	if err != nil {
		t.Fatalf("tail file: %v", err)
	}
	if strings.Join(lines, ",") != "c,d" {
		t.Fatalf("unexpected lines: %v", lines)
	}
}
