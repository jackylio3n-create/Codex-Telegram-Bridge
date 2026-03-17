package daemon

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestRotatingFileWriterRotatesAndKeepsBackups(t *testing.T) {
	t.Parallel()

	logPath := filepath.Join(t.TempDir(), "bridge.log")
	writer, err := newRotatingFileWriter(logPath, 32, 2)
	if err != nil {
		t.Fatalf("new rotating writer: %v", err)
	}
	defer writer.Close()

	line := bytes.Repeat([]byte("a"), 20)
	for range 4 {
		if _, err := writer.Write(append(line, '\n')); err != nil {
			t.Fatalf("write log line: %v", err)
		}
	}

	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("expected current log file: %v", err)
	}
	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Fatalf("expected rotated log file: %v", err)
	}
	if _, err := os.Stat(logPath + ".2"); err != nil {
		t.Fatalf("expected second rotated log file: %v", err)
	}
	if _, err := os.Stat(logPath + ".3"); !os.IsNotExist(err) {
		t.Fatalf("expected only two backups, got err=%v", err)
	}
}
