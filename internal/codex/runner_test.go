package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codextelegrambridge/internal/model"
)

func TestRunCapturesAgentMessage(t *testing.T) {
	t.Parallel()

	executable := writeFakeCodex(t)
	run := Start(context.Background(), Options{
		Executable: executable,
		Prompt:     "hello",
		CWD:        t.TempDir(),
		Mode:       model.ModeCode,
	})

	select {
	case result := <-run.Result:
		if result.ExitCode != 0 {
			t.Fatalf("expected exit 0, got %d", result.ExitCode)
		}
		if result.ThreadID != "thread-live" {
			t.Fatalf("expected thread-live, got %q", result.ThreadID)
		}
		if result.FinalMessage != "Default answer" {
			t.Fatalf("expected Default answer, got %q", result.FinalMessage)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for run result")
	}
}

func TestRunRecoversFromStaleResumeThread(t *testing.T) {
	t.Parallel()

	executable := writeFakeCodex(t)
	run := Start(context.Background(), Options{
		Executable:     executable,
		Prompt:         "hello",
		ResumeThreadID: "thread-old",
		RollingSummary: "summary text",
		CWD:            t.TempDir(),
		Mode:           model.ModeCode,
	})

	select {
	case result := <-run.Result:
		if !result.StaleRecovered {
			t.Fatalf("expected stale recovery")
		}
		if !result.UsedSummarySeed {
			t.Fatalf("expected rolling summary seed to be used")
		}
		if result.ThreadID != "thread-live" {
			t.Fatalf("expected recovered thread-live, got %q", result.ThreadID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for recovered run result")
	}
}

func TestRunEmitsApprovalRequest(t *testing.T) {
	t.Parallel()

	executable := writeApprovalCodex(t)
	run := Start(context.Background(), Options{
		Executable: executable,
		Prompt:     "needs approval",
		CWD:        t.TempDir(),
		Mode:       model.ModeCode,
	})

	select {
	case event := <-run.Events:
		if event.Kind != EventThreadStarted {
			t.Fatalf("expected first event to be thread started, got %s", event.Kind)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for first runner event")
	}

	select {
	case event := <-run.Events:
		if event.Kind != EventApprovalRequest {
			t.Fatalf("expected approval request, got %s", event.Kind)
		}
		if event.Summary != "git status (workspace_write_required)" {
			t.Fatalf("unexpected summary: %q", event.Summary)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for approval request")
	}
}

func TestBuildArgsForResumeOmitsUnsupportedFlags(t *testing.T) {
	t.Parallel()

	args := buildArgs(Options{
		Prompt:         "hello",
		ResumeThreadID: "thread-123",
		CWD:            "/tmp/workspace",
		Mode:           model.ModeCode,
		ExtraWritable:  []string{"/tmp/extra"},
		Images:         []string{"image.png"},
	})

	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--add-dir") {
		t.Fatalf("resume args must not include --add-dir: %q", joined)
	}
	if strings.Contains(joined, "-C ") {
		t.Fatalf("resume args must not include -C: %q", joined)
	}
	if !strings.Contains(joined, "exec resume --json --skip-git-repo-check") {
		t.Fatalf("unexpected resume args: %q", joined)
	}
	if !strings.Contains(joined, "thread-123 -") {
		t.Fatalf("resume thread id/prompt marker missing: %q", joined)
	}
}

func writeFakeCodex(t *testing.T) string {
	t.Helper()

	dir := t.TempDir()
	path := filepath.Join(dir, "fake-codex.sh")
	script := `#!/usr/bin/env bash
set -euo pipefail
if [[ "${2:-}" == "resume" ]]; then
  echo '{"type":"thread.started","thread_id":"thread-mismatch"}'
  echo '{"type":"agent_message","message":"Stale thread"}'
  exit 0
fi
echo '{"type":"thread.started","thread_id":"thread-live"}'
echo '{"type":"agent_message","message":"Default answer"}'
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	return path
}

func writeApprovalCodex(t *testing.T) string {
	t.Helper()

	dir := t.TempDir()
	path := filepath.Join(dir, "fake-codex-approval.sh")
	script := `#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
trap 'exit 0' INT
if [[ "${prompt}" == *"Resume the previous task"* ]]; then
  echo '{"type":"thread.started","thread_id":"thread-live"}'
  echo '{"type":"agent_message","message":"Approved answer"}'
  exit 0
fi
echo '{"type":"thread.started","thread_id":"thread-live"}'
echo '{"type":"exec_approval_request","call_id":"call-1","command":["git","status"],"cwd":"/tmp","reason":"workspace_write_required"}'
sleep 30
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write approval codex: %v", err)
	}
	return path
}
