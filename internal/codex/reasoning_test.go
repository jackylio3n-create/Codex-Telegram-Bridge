package codex

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadWriteReasoningEffort(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	if err := WriteReasoningEffort(codexHome, "high"); err != nil {
		t.Fatalf("write reasoning effort: %v", err)
	}

	current, err := ReadReasoningEffort(codexHome)
	if err != nil {
		t.Fatalf("read reasoning effort: %v", err)
	}
	if current != "high" {
		t.Fatalf("expected high, got %q", current)
	}

	raw, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		t.Fatalf("read config.toml: %v", err)
	}
	if string(raw) != "model_reasoning_effort = \"high\"\n" {
		t.Fatalf("unexpected file content: %q", string(raw))
	}
}

func TestWriteReasoningEffortReplacesExistingLine(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	configPath := filepath.Join(codexHome, "config.toml")
	if err := os.WriteFile(configPath, []byte("foo = \"bar\"\nmodel_reasoning_effort = \"low\"\n"), 0o600); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	if err := WriteReasoningEffort(codexHome, "xhigh"); err != nil {
		t.Fatalf("rewrite reasoning effort: %v", err)
	}
	current, err := ReadReasoningEffort(codexHome)
	if err != nil {
		t.Fatalf("read rewritten effort: %v", err)
	}
	if current != "xhigh" {
		t.Fatalf("expected xhigh, got %q", current)
	}
}
