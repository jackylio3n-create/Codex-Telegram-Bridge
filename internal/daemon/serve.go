package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"codextelegrambridge/internal/app"
	"codextelegrambridge/internal/codex"
	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/store"
	"codextelegrambridge/internal/telegram"
)

type Options struct {
	Logger         *slog.Logger
	TelegramClient *telegram.Client
}

func Serve(ctx context.Context, cfg config.Config, options Options) error {
	if err := cfg.EnsureDirectories(); err != nil {
		return err
	}

	existingPID, err := ReadPIDFile(cfg.PIDFilePath)
	if err != nil {
		return fmt.Errorf("read pid file: %w", err)
	}
	if existingPID != 0 {
		if IsProcessRunning(existingPID) {
			return fmt.Errorf("bridge daemon is already running (pid %d)", existingPID)
		}
		if err := RemovePIDFile(cfg.PIDFilePath); err != nil {
			return fmt.Errorf("remove stale pid file: %w", err)
		}
	}

	logFile, err := os.OpenFile(cfg.LogFilePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	defer logFile.Close()

	logger := options.Logger
	if logger == nil {
		logger = newLogger(cfg.LogLevel, io.MultiWriter(logFile, os.Stdout))
	}

	if err := WritePIDFile(cfg.PIDFilePath, os.Getpid()); err != nil {
		return fmt.Errorf("write pid file: %w", err)
	}
	defer func() {
		if err := RemovePIDFile(cfg.PIDFilePath); err != nil {
			logger.Warn("remove pid file failed", "err", err)
		}
	}()

	state := newStateManager(cfg)
	state.SetStatus(StatusStarting, "daemon starting")

	storeHandle, err := store.Open(cfg.DatabasePath)
	if err != nil {
		state.SetStatus(StatusError, err.Error())
		return fmt.Errorf("open store: %w", err)
	}
	defer storeHandle.Close()
	state.AttachStore(storeHandle)

	client := options.TelegramClient
	if client == nil {
		client = telegram.NewClient(cfg.TelegramBotToken)
	}

	serveCtx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	coordinator := app.NewCoordinator(cfg, logger, storeHandle, client)
	coordinator.SetObserver(state)

	go func() {
		<-serveCtx.Done()
		state.SetStatus(StatusStopping, "shutdown requested")
	}()

	logger.Info("bridge daemon starting", "pid", os.Getpid(), "log_file", cfg.LogFilePath, "database", cfg.DatabasePath)
	state.SetStatus(StatusRunning, "daemon running")

	err = coordinator.Run(serveCtx)
	if err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("bridge daemon crashed", "err", err)
		state.SetStatus(StatusError, err.Error())
		return err
	}

	logger.Info("bridge daemon stopped", "pid", os.Getpid())
	state.SetStatus(StatusStopped, "daemon stopped")
	return nil
}

func newLogger(level string, writer io.Writer) *slog.Logger {
	return slog.New(slog.NewTextHandler(writer, &slog.HandlerOptions{Level: parseLevel(level)}))
}

func parseLevel(level string) slog.Level {
	switch level {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

type stateManager struct {
	mu      sync.Mutex
	cfg     config.Config
	store   *store.Store
	started string
	current RuntimeState
	lastPID int
}

func newStateManager(cfg config.Config) *stateManager {
	pid := os.Getpid()
	state := RuntimeState{
		Version:          1,
		Phase:            "daemon",
		Status:           StatusStarting,
		UpdatedAt:        nowRFC3339(),
		StartedAt:        nowRFC3339(),
		PID:              intPtr(pid),
		LogFilePath:      cfg.LogFilePath,
		DatabaseFilePath: cfg.DatabasePath,
	}
	manager := &stateManager{
		cfg:     cfg,
		started: state.StartedAt,
		current: state,
		lastPID: pid,
	}
	_ = manager.writeLocked()
	return manager
}

func (m *stateManager) AttachStore(storeHandle *store.Store) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.store = storeHandle
	m.refreshSessionCountLocked()
	_ = m.writeLocked()
}

func (m *stateManager) SetStatus(status RuntimeStatus, event string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.current.Status = status
	m.current.LastEvent = event
	m.current.UpdatedAt = nowRFC3339()
	m.current.StartedAt = m.started
	if status == StatusStopped || status == StatusError {
		m.current.PID = nil
		m.current.ActiveRunCount = 0
	} else {
		m.current.PID = intPtr(m.lastPID)
	}
	m.refreshSessionCountLocked()
	_ = m.writeLocked()
}

func (m *stateManager) PollStarted(offset int64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := nowRFC3339()
	m.current.LastPollAt = now
	m.current.PreviousOffset = int64Ptr(offset)
	if m.current.CurrentOffset == nil {
		m.current.CurrentOffset = int64Ptr(offset)
	}
	m.current.LastEvent = "telegram poll started"
	m.current.UpdatedAt = now
	_ = m.writeLocked()
}

func (m *stateManager) PollSucceeded(previousOffset, currentOffset int64, updateCount int) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := nowRFC3339()
	m.current.LastPollAt = now
	m.current.LastSuccessfulPollAt = now
	m.current.LastPollError = ""
	m.current.PreviousOffset = int64Ptr(previousOffset)
	m.current.CurrentOffset = int64Ptr(currentOffset)
	m.current.LastEvent = fmt.Sprintf("telegram poll succeeded (%d updates)", updateCount)
	m.current.UpdatedAt = now
	_ = m.writeLocked()
}

func (m *stateManager) PollFailed(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := nowRFC3339()
	m.current.LastPollAt = now
	m.current.LastFailedPollAt = now
	m.current.LastPollError = err.Error()
	m.current.LastEvent = "telegram poll failed"
	m.current.UpdatedAt = now
	_ = m.writeLocked()
}

func (m *stateManager) UpdateHandled(updateID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.current.LastEvent = fmt.Sprintf("handled update %d", updateID)
	m.current.UpdatedAt = nowRFC3339()
	m.refreshSessionCountLocked()
	_ = m.writeLocked()
}

func (m *stateManager) RunStarted(sessionID, runID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.current.ActiveRunCount = 1
	m.current.LastEvent = fmt.Sprintf("run started: %s (%s)", runID, sessionID)
	m.current.UpdatedAt = nowRFC3339()
	m.refreshSessionCountLocked()
	_ = m.writeLocked()
}

func (m *stateManager) RunFinished(sessionID, runID string, result codex.Result) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.current.ActiveRunCount = 0
	m.current.LastEvent = fmt.Sprintf("run finished: %s (%s) exit=%d", runID, sessionID, result.ExitCode)
	m.current.UpdatedAt = nowRFC3339()
	m.refreshSessionCountLocked()
	_ = m.writeLocked()
}

func (m *stateManager) ApprovalRequested(sessionID, runID, actionID, summary string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.current.ActiveRunCount = 1
	m.current.LastEvent = fmt.Sprintf("approval requested: %s (%s)", actionID, summary)
	m.current.UpdatedAt = nowRFC3339()
	m.refreshSessionCountLocked()
	_ = m.writeLocked()
}

func (m *stateManager) refreshSessionCountLocked() {
	if m.store == nil {
		return
	}
	sessions, err := m.store.ListSessions(context.Background())
	if err != nil {
		return
	}
	m.current.ActiveSessionCount = len(sessions)
}

func (m *stateManager) writeLocked() error {
	return WriteRuntimeState(m.cfg.StateFilePath, m.current)
}

func intPtr(value int) *int {
	return &value
}

func int64Ptr(value int64) *int64 {
	return &value
}
