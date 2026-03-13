package app

import (
	"path/filepath"
	"strings"
	"testing"

	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/model"
)

func TestBuildRunOptionsHonorsModeAndScope(t *testing.T) {
	t.Parallel()

	tempRoot := t.TempDir()
	coordinator := &Coordinator{
		cfg: config.Config{
			TempDir:             filepath.Join(tempRoot, "tmp"),
			CodexHome:           filepath.Join(tempRoot, ".codex"),
			CodexExecutable:     "codex",
			CodexApprovalPolicy: "never",
			CodexSandboxMode:    "danger-full-access",
		},
	}

	askOptions, _, err := coordinator.buildRunOptions(model.Session{
		CWD:         "/tmp/workspace",
		Mode:        model.ModeAsk,
		AccessScope: model.ScopeSystem,
	}, "answer this", nil)
	if err != nil {
		t.Fatalf("build ask options: %v", err)
	}
	if askOptions.SandboxMode != "read-only" {
		t.Fatalf("expected ask mode read-only sandbox, got %q", askOptions.SandboxMode)
	}
	if !strings.Contains(askOptions.Prompt, "You are operating in ask mode.") {
		t.Fatalf("expected ask prompt wrapper, got %q", askOptions.Prompt)
	}

	planOptions, cleanups, err := coordinator.buildRunOptions(model.Session{
		CWD:         "/tmp/workspace",
		Mode:        model.ModePlan,
		AccessScope: model.ScopeSystem,
	}, "plan this", nil)
	if err != nil {
		t.Fatalf("build plan options: %v", err)
	}
	defer func() {
		for _, cleanup := range cleanups {
			cleanup()
		}
	}()
	if planOptions.SandboxMode != "read-only" {
		t.Fatalf("expected plan mode read-only sandbox, got %q", planOptions.SandboxMode)
	}
	if planOptions.OutputSchemaPath == "" {
		t.Fatalf("expected plan mode output schema path")
	}

	codeOptions, _, err := coordinator.buildRunOptions(model.Session{
		CWD:         "/tmp/workspace",
		Mode:        model.ModeCode,
		AccessScope: model.ScopeWorkspace,
	}, "fix it", nil)
	if err != nil {
		t.Fatalf("build code options: %v", err)
	}
	if codeOptions.SandboxMode != "workspace-write" {
		t.Fatalf("expected workspace scope sandbox, got %q", codeOptions.SandboxMode)
	}
}

func TestResetSessionExecutionContext(t *testing.T) {
	t.Parallel()

	session := &model.Session{
		CodexThreadID:  "thread-1",
		RollingSummary: "summary",
		ActiveRunID:    "run-1",
		StaleRecovered: true,
	}
	(&Coordinator{}).resetSessionExecutionContext(session)
	if session.CodexThreadID != "" || session.RollingSummary != "" || session.ActiveRunID != "" || session.StaleRecovered {
		t.Fatalf("expected session execution context to be reset, got %#v", session)
	}
}
