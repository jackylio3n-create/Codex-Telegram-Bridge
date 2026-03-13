package codex

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadRuntimeInfo(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(codexHome, "sessions", "2026", "03", "13"), 0o700); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model = \"gpt-5.4\"\nmodel_reasoning_effort = \"high\"\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	body := "" +
		"{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.4\",\"effort\":\"high\"}}\n" +
		"{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"total_tokens\":1200},\"model_context_window\":200000},\"rate_limits\":{\"primary\":{\"used_percent\":25.0,\"window_minutes\":300,\"resets_at\":1770996103},\"secondary\":{\"used_percent\":40.0,\"window_minutes\":10080,\"resets_at\":1771267415}}}}\n"
	path := filepath.Join(codexHome, "sessions", "2026", "03", "13", "sample.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write session: %v", err)
	}

	info, err := ReadRuntimeInfo(codexHome)
	if err != nil {
		t.Fatalf("read runtime info: %v", err)
	}
	if info.Model != "gpt-5.4" {
		t.Fatalf("unexpected model: %q", info.Model)
	}
	if info.ReasoningEffort != "high" {
		t.Fatalf("unexpected effort: %q", info.ReasoningEffort)
	}
	if info.ContextRemaining != 198800 {
		t.Fatalf("unexpected context remaining: %d", info.ContextRemaining)
	}
	if FormatWindowRemaining(info.PrimaryUsedPercent) != "75.0%" {
		t.Fatalf("unexpected primary remaining: %s", FormatWindowRemaining(info.PrimaryUsedPercent))
	}
}
