package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"codextelegrambridge/internal/model"
)

type EventKind string

const (
	EventThreadStarted   EventKind = "thread_started"
	EventAgentMessage    EventKind = "agent_message"
	EventApprovalRequest EventKind = "approval_request"
	EventExecBegin       EventKind = "exec_command_begin"
	EventExecEnd         EventKind = "exec_command_end"
	EventPatchBegin      EventKind = "patch_apply_begin"
	EventStderr          EventKind = "stderr"
)

type Event struct {
	Kind         EventKind
	ThreadID     string
	Text         string
	Summary      string
	Command      []string
	ChangedPaths []string
	ExitCode     int
	Status       string
}

type Result struct {
	ThreadID        string
	FinalMessage    string
	ExitCode        int
	StaleRecovered  bool
	UsedSummarySeed bool
}

type Options struct {
	Executable       string
	Prompt           string
	ResumeThreadID   string
	RollingSummary   string
	CWD              string
	Mode             model.SessionMode
	ReasoningEffort  string
	ApprovalPolicy   string
	SandboxMode      string
	OutputSchemaPath string
	ExtraWritable    []string
	Images           []string
	Environment      []string
}

type Run struct {
	Events chan Event
	Result chan Result

	mu   sync.Mutex
	cmd  *exec.Cmd
	done chan struct{}
}

func Start(ctx context.Context, options Options) *Run {
	run := &Run{
		Events: make(chan Event, 64),
		Result: make(chan Result, 1),
		done:   make(chan struct{}),
	}
	go run.run(ctx, options)
	return run
}

func (r *Run) Cancel() model.CancellationResult {
	r.mu.Lock()
	cmd := r.cmd
	r.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return model.CancelFull
	}
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		return model.CancelUnknown
	}
	timer := time.NewTimer(1500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-r.done:
		return model.CancelPartial
	case <-timer.C:
		_ = cmd.Process.Kill()
		return model.CancelPartial
	}
}

func (r *Run) run(ctx context.Context, options Options) {
	defer close(r.Events)
	defer close(r.Result)
	defer close(r.done)

	result := r.launch(ctx, options)
	if result.StaleRecovered || options.ResumeThreadID == "" || result.ThreadID == "" || result.ThreadID == options.ResumeThreadID {
		r.Result <- result
		return
	}

	_ = r.Cancel()
	result = r.launch(ctx, Options{
		Executable:       options.Executable,
		Prompt:           buildPromptWithRollingSummary(options.Prompt, options.RollingSummary),
		CWD:              options.CWD,
		Mode:             options.Mode,
		ReasoningEffort:  options.ReasoningEffort,
		ApprovalPolicy:   options.ApprovalPolicy,
		SandboxMode:      options.SandboxMode,
		OutputSchemaPath: options.OutputSchemaPath,
		ExtraWritable:    options.ExtraWritable,
		Images:           options.Images,
		Environment:      options.Environment,
	})
	result.StaleRecovered = true
	result.UsedSummarySeed = strings.TrimSpace(options.RollingSummary) != ""
	r.Result <- result
}

func (r *Run) launch(ctx context.Context, options Options) Result {
	args := buildArgs(options)
	cmd := exec.CommandContext(ctx, options.Executable, args...)
	cmd.Dir = options.CWD
	if len(options.Environment) > 0 {
		cmd.Env = append(os.Environ(), options.Environment...)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{ExitCode: 1, FinalMessage: err.Error()}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{ExitCode: 1, FinalMessage: err.Error()}
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Result{ExitCode: 1, FinalMessage: err.Error()}
	}

	if err := cmd.Start(); err != nil {
		return Result{ExitCode: 1, FinalMessage: err.Error()}
	}

	r.mu.Lock()
	r.cmd = cmd
	r.mu.Unlock()

	_, _ = io.WriteString(stdin, options.Prompt+"\n")
	_ = stdin.Close()

	var result Result
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		scanStdout(stdout, func(event Event) {
			switch event.Kind {
			case EventThreadStarted:
				result.ThreadID = event.ThreadID
			case EventAgentMessage:
				result.FinalMessage = event.Text
			}
			r.Events <- event
		})
	}()
	go func() {
		defer wg.Done()
		scanStderr(stderr, func(line string) {
			r.Events <- Event{Kind: EventStderr, Text: line}
		})
	}()

	err = cmd.Wait()
	wg.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = 1
			if result.FinalMessage == "" {
				result.FinalMessage = err.Error()
			}
		}
	} else {
		result.ExitCode = 0
	}
	if result.FinalMessage == "" {
		switch result.ExitCode {
		case 0:
			result.FinalMessage = "Run completed."
		default:
			result.FinalMessage = fmt.Sprintf("Codex exited with %d.", result.ExitCode)
		}
	}
	return result
}

func buildArgs(options Options) []string {
	args := []string{"exec"}
	if options.ResumeThreadID != "" {
		args = append(args, "resume", "--json", "--skip-git-repo-check")
		appendResumeArgs(&args, options.Mode, options.ReasoningEffort, options.ApprovalPolicy, options.SandboxMode, options.OutputSchemaPath, options.Images)
		args = append(args, options.ResumeThreadID)
		args = append(args, "-")
		return args
	}

	args = append(args, "--json", "--skip-git-repo-check", "-C", options.CWD)
	appendConfigArgs(&args, options.Mode, options.ReasoningEffort, options.ApprovalPolicy, options.SandboxMode, options.OutputSchemaPath, options.ExtraWritable, options.Images)
	args = append(args, "-")
	return args
}

func appendSharedArgs(args *[]string, mode model.SessionMode, reasoningEffort, approvalPolicy, sandboxMode, outputSchemaPath string, extraWritable, images []string) {
	*args = append(*args, "--json", "--skip-git-repo-check")
	appendConfigArgs(args, mode, reasoningEffort, approvalPolicy, sandboxMode, outputSchemaPath, extraWritable, images)
}

func appendResumeArgs(args *[]string, mode model.SessionMode, reasoningEffort, approvalPolicy, sandboxMode, outputSchemaPath string, images []string) {
	appendConfigArgs(args, mode, reasoningEffort, approvalPolicy, sandboxMode, outputSchemaPath, nil, images)
}

func appendConfigArgs(args *[]string, mode model.SessionMode, reasoningEffort, approvalPolicy, sandboxMode, outputSchemaPath string, extraWritable, images []string) {
	_ = mode
	reasoningEffort = strings.TrimSpace(reasoningEffort)
	approvalPolicy = strings.TrimSpace(approvalPolicy)
	if approvalPolicy == "" {
		approvalPolicy = "never"
	}
	sandboxMode = strings.TrimSpace(sandboxMode)
	if sandboxMode == "" {
		sandboxMode = "danger-full-access"
	}
	*args = append(*args, "-c", fmt.Sprintf(`approval_policy="%s"`, approvalPolicy), "-c", fmt.Sprintf(`sandbox_mode="%s"`, sandboxMode))
	if reasoningEffort != "" {
		*args = append(*args, "-c", fmt.Sprintf(`model_reasoning_effort="%s"`, reasoningEffort))
	}
	if strings.TrimSpace(outputSchemaPath) != "" {
		*args = append(*args, "--output-schema", outputSchemaPath)
	}
	for _, image := range images {
		*args = append(*args, "-i", image)
	}
	for _, writable := range extraWritable {
		*args = append(*args, "--add-dir", filepath.Clean(writable))
	}
}

func scanStdout(reader io.Reader, emit func(Event)) {
	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 0, 64*1024)
	scanner.Buffer(buffer, 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if event, ok := parseEvent(line); ok {
			emit(event)
		}
	}
}

func scanStderr(reader io.Reader, emit func(string)) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			emit(line)
		}
	}
}

func parseEvent(line string) (Event, bool) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return Event{}, false
	}
	typ, _ := raw["type"].(string)
	switch typ {
	case "thread.started":
		threadID, _ := raw["thread_id"].(string)
		return Event{Kind: EventThreadStarted, ThreadID: threadID}, true
	case "item.completed":
		item, _ := raw["item"].(map[string]any)
		if itemType, _ := item["type"].(string); itemType == "agent_message" {
			text, _ := item["text"].(string)
			return Event{Kind: EventAgentMessage, Text: text}, true
		}
	case "agent_message":
		text, _ := raw["message"].(string)
		return Event{Kind: EventAgentMessage, Text: text}, true
	case "exec_approval_request":
		command := readStringSlice(raw["command"])
		reason, _ := raw["reason"].(string)
		summary := strings.Join(command, " ")
		if reason != "" {
			summary = summary + " (" + reason + ")"
		}
		return Event{Kind: EventApprovalRequest, Summary: summary, Command: command}, true
	case "exec_command_begin":
		return Event{Kind: EventExecBegin, Command: readStringSlice(raw["command"])}, true
	case "exec_command_end":
		exitCode := 0
		if value, ok := raw["exit_code"].(float64); ok {
			exitCode = int(value)
		}
		status, _ := raw["status"].(string)
		return Event{Kind: EventExecEnd, Command: readStringSlice(raw["command"]), ExitCode: exitCode, Status: status}, true
	case "patch_apply_begin":
		changes, _ := raw["changes"].(map[string]any)
		paths := make([]string, 0, len(changes))
		for key := range changes {
			paths = append(paths, key)
		}
		return Event{Kind: EventPatchBegin, ChangedPaths: paths}, true
	}
	return Event{}, false
}

func readStringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	output := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			output = append(output, text)
		}
	}
	return output
}

func buildPromptWithRollingSummary(prompt, rollingSummary string) string {
	rollingSummary = strings.TrimSpace(rollingSummary)
	prompt = strings.TrimSpace(prompt)
	if rollingSummary == "" {
		return prompt
	}
	return "Historical context recovered from the bridge rolling summary:\n" + rollingSummary + "\n\nCurrent user request:\n" + prompt
}
