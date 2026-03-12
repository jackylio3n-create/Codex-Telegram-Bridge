package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"codextelegrambridge/internal/codex"
	"codextelegrambridge/internal/config"
	"codextelegrambridge/internal/model"
	"codextelegrambridge/internal/policy"
	"codextelegrambridge/internal/store"
	"codextelegrambridge/internal/telegram"
)

const verificationBanThreshold = 5

type Coordinator struct {
	cfg    config.Config
	logger *slog.Logger
	store  *store.Store
	tg     *telegram.Client

	events chan any
	active *activeRun
}

type activeRun struct {
	SessionID        string
	RunID            string
	ChatID           string
	UserID           string
	PreviewMessageID int64
	Runner           *codex.Run
	PendingActionID  string
	StopRequested    bool
	LastCancel       model.CancellationResult
	Cleanup          []func()
}

type telegramEvent struct {
	Update telegram.Update
}

type codexEvent struct {
	RunID string
	Event codex.Event
}

type runFinished struct {
	RunID  string
	Result codex.Result
}

func NewCoordinator(cfg config.Config, logger *slog.Logger, store *store.Store, tg *telegram.Client) *Coordinator {
	return &Coordinator{
		cfg:    cfg,
		logger: logger,
		store:  store,
		tg:     tg,
		events: make(chan any, 256),
	}
}

func (c *Coordinator) Run(ctx context.Context) error {
	go c.pollTelegram(ctx)

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.stopActiveRun()
			return ctx.Err()
		case event := <-c.events:
			switch typed := event.(type) {
			case telegramEvent:
				if err := c.handleUpdate(ctx, typed.Update); err != nil {
					c.logger.Error("handle update failed", "err", err)
				}
				_ = c.store.SetTelegramOffset(ctx, typed.Update.UpdateID+1)
			case codexEvent:
				if err := c.handleCodexEvent(ctx, typed.RunID, typed.Event); err != nil {
					c.logger.Error("handle codex event failed", "err", err)
				}
			case runFinished:
				if err := c.handleRunFinished(ctx, typed.RunID, typed.Result); err != nil {
					c.logger.Error("handle run finished failed", "err", err)
				}
			}
		case <-ticker.C:
			if err := c.expirePendingActions(ctx); err != nil {
				c.logger.Warn("expire approvals failed", "err", err)
			}
			_ = c.store.Cleanup(ctx, time.Now().AddDate(0, 0, -c.cfg.ResolvedApprovalRetentionDays), time.Now().AddDate(0, 0, -c.cfg.ExpiredApprovalRetentionDays), c.cfg.MaxAuditRows)
		}
	}
}

func (c *Coordinator) pollTelegram(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		offset, err := c.store.GetTelegramOffset(ctx)
		if err != nil {
			c.logger.Warn("read telegram offset failed", "err", err)
			time.Sleep(2 * time.Second)
			continue
		}
		updates, err := c.tg.GetUpdates(ctx, offset, 30)
		if err != nil {
			c.logger.Warn("telegram getUpdates failed", "err", err)
			time.Sleep(2 * time.Second)
			continue
		}
		for _, update := range updates {
			select {
			case <-ctx.Done():
				return
			case c.events <- telegramEvent{Update: update}:
			}
		}
	}
}

func (c *Coordinator) handleUpdate(ctx context.Context, update telegram.Update) error {
	if update.EditedMessage != nil {
		return nil
	}
	if update.CallbackQuery != nil {
		return c.handleCallback(ctx, update.CallbackQuery)
	}
	if update.Message != nil {
		return c.handleMessage(ctx, update.Message)
	}
	return nil
}

func (c *Coordinator) handleMessage(ctx context.Context, message *telegram.Message) error {
	if message.Chat.Type != "private" || message.From == nil {
		return nil
	}
	userID := fmt.Sprintf("%d", message.From.ID)
	chatID := fmt.Sprintf("%d", message.Chat.ID)
	if userID != c.cfg.OwnerUserID {
		return nil
	}
	if c.cfg.OwnerChatID != "" && chatID != c.cfg.OwnerChatID {
		_, _ = c.tg.SendMessage(ctx, chatID, "This chat is not authorized for the bridge.", nil)
		return nil
	}
	if err := c.store.SetOwnerChatID(ctx, chatID); err != nil {
		return err
	}

	auth, err := c.store.GetOrCreateTelegramUserAuth(ctx, userID, chatID)
	if err != nil {
		return err
	}
	if auth.BannedAt != nil {
		_, _ = c.tg.SendMessage(ctx, chatID, "Too many incorrect attempts. This Telegram user ID has been blocked locally.", nil)
		return nil
	}

	if handled, err := c.handleVerificationAndLanguage(ctx, auth, message); handled || err != nil {
		return err
	}

	text := strings.TrimSpace(message.Text)
	if strings.HasPrefix(text, "/") {
		return c.handleCommand(ctx, chatID, userID, text)
	}
	return c.handleUserInput(ctx, chatID, userID, message)
}

func (c *Coordinator) handleCallback(ctx context.Context, callback *telegram.CallbackQuery) error {
	if callback.Message == nil {
		return nil
	}
	chatID := fmt.Sprintf("%d", callback.Message.Chat.ID)
	userID := fmt.Sprintf("%d", callback.From.ID)
	if userID != c.cfg.OwnerUserID {
		_ = c.tg.AnswerCallback(ctx, callback.ID, "Unauthorized.", true)
		return nil
	}
	auth, err := c.store.GetOrCreateTelegramUserAuth(ctx, userID, chatID)
	if err != nil {
		return err
	}

	data := strings.TrimSpace(callback.Data)
	switch {
	case strings.HasPrefix(data, "lang:"):
		if auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, "Verification required.", true)
		}
		language := strings.TrimPrefix(data, "lang:")
		if language != "zh" && language != "en" {
			return c.tg.AnswerCallback(ctx, callback.ID, "Unknown language.", true)
		}
		if err := c.store.SetPreferredLanguage(ctx, userID, chatID, language); err != nil {
			return err
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, "Language saved.", false); err != nil {
			return err
		}
		_, _ = c.tg.SendMessage(ctx, chatID, "Language saved. You can now use /new and start chatting.", nil)
		return nil
	case strings.HasPrefix(data, "pa:"):
		if err := c.tg.AnswerCallback(ctx, callback.ID, "Received.", false); err != nil {
			return err
		}
		return c.resolveApproval(ctx, chatID, userID, strings.TrimPrefix(data, "pa:"), true)
	case strings.HasPrefix(data, "pd:"):
		if err := c.tg.AnswerCallback(ctx, callback.ID, "Received.", false); err != nil {
			return err
		}
		return c.resolveApproval(ctx, chatID, userID, strings.TrimPrefix(data, "pd:"), false)
	default:
		return c.tg.AnswerCallback(ctx, callback.ID, "Expired or already handled.", true)
	}
}

func (c *Coordinator) handleVerificationAndLanguage(ctx context.Context, auth *model.TelegramUserAuth, message *telegram.Message) (bool, error) {
	chatID := fmt.Sprintf("%d", message.Chat.ID)
	userID := fmt.Sprintf("%d", message.From.ID)
	text := strings.TrimSpace(message.Text)

	if c.cfg.VerificationPasswordHash != "" && auth.VerifiedAt == nil {
		if strings.HasPrefix(text, "/start") {
			_, err := c.tg.SendMessage(ctx, chatID, "Welcome. Please send the verification password in your next message to confirm your identity.", nil)
			return true, err
		}
		if text == "" || strings.HasPrefix(text, "/") {
			_, err := c.tg.SendMessage(ctx, chatID, "Please send the verification password first.", nil)
			return true, err
		}
		if policy.VerifyPassword(text, c.cfg.VerificationPasswordHash) {
			if err := c.store.MarkVerified(ctx, userID, chatID); err != nil {
				return true, err
			}
			return true, c.sendLanguagePicker(ctx, chatID)
		}
		updated, err := c.store.RecordFailedAttempt(ctx, userID, chatID, verificationBanThreshold)
		if err != nil {
			return true, err
		}
		message := "Incorrect password. Please try again."
		if updated.BannedAt != nil {
			message = "Too many incorrect attempts. This Telegram user ID has been blocked locally."
		}
		_, err = c.tg.SendMessage(ctx, chatID, message, nil)
		return true, err
	}

	if auth.VerifiedAt != nil && auth.PreferredLanguage == "" {
		if strings.HasPrefix(text, "/start") {
			return true, c.sendLanguagePicker(ctx, chatID)
		}
		_, err := c.tg.SendMessage(ctx, chatID, "Please choose your prompt language first.", &telegram.InlineKeyboardMarkup{
			InlineKeyboard: [][]telegram.InlineKeyboardButton{{
				{Text: "中文", CallbackData: "lang:zh"},
				{Text: "English", CallbackData: "lang:en"},
			}},
		})
		return true, err
	}
	return false, nil
}

func (c *Coordinator) sendLanguagePicker(ctx context.Context, chatID string) error {
	_, err := c.tg.SendMessage(ctx, chatID, "Verification successful. Please choose your prompt language.", &telegram.InlineKeyboardMarkup{
		InlineKeyboard: [][]telegram.InlineKeyboardButton{{
			{Text: "中文", CallbackData: "lang:zh"},
			{Text: "English", CallbackData: "lang:en"},
		}},
	})
	return err
}

func (c *Coordinator) handleCommand(ctx context.Context, chatID, userID, text string) error {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return nil
	}
	cmd := fields[0]
	args := fields[1:]

	_ = c.store.AppendAudit(ctx, model.AuditRecord{
		ChatID:    chatID,
		SessionID: c.currentSessionID(ctx),
		EventType: "user_command",
		Payload: map[string]any{
			"command": cmd,
			"args":    strings.Join(args, " "),
		},
	})

	switch cmd {
	case "/start":
		_, err := c.tg.SendMessage(ctx, chatID, "Codex + Telegram Bridge is available. Use /new to create a session or /help to see commands.", nil)
		return err
	case "/help":
		_, err := c.tg.SendMessage(ctx, chatID, c.helpText(), nil)
		return err
	case "/new":
		return c.commandNew(ctx, chatID, args)
	case "/reset":
		return c.commandReset(ctx, chatID)
	case "/cd":
		if len(args) == 0 {
			_, err := c.tg.SendMessage(ctx, chatID, "Usage: /cd <path>", nil)
			return err
		}
		return c.commandCD(ctx, chatID, strings.Join(args, " "))
	case "/mode":
		return c.commandMode(ctx, chatID, args)
	case "/scope":
		return c.commandScope(ctx, chatID, args)
	case "/ctx", "/stat":
		return c.commandStatus(ctx, chatID)
	case "/stop":
		return c.commandStop(ctx, chatID)
	case "/perm":
		return c.commandPerm(ctx, chatID, userID, args)
	case "/think":
		return c.commandThink(ctx, chatID, args)
	default:
		_, err := c.tg.SendMessage(ctx, chatID, "Unsupported command.", nil)
		return err
	}
}

func (c *Coordinator) commandNew(ctx context.Context, chatID string, args []string) error {
	root, err := policy.ValidateWorkspaceRoot(c.cfg.DefaultWorkspaceRoot)
	if err != nil {
		return err
	}
	cwd := root
	if len(args) > 0 {
		probe := model.Session{
			WorkspaceRoot: root,
			CWD:           root,
			AccessScope:   model.ScopeSystem,
		}
		cwd, err = policy.ResolveDirectory(probe, strings.Join(args, " "))
		if err != nil {
			_, sendErr := c.tg.SendMessage(ctx, chatID, err.Error(), nil)
			return sendErr
		}
	}
	now := time.Now().UTC()
	session := model.Session{
		SessionID:        "session-" + randomID(),
		WorkspaceRoot:    root,
		ExtraAllowedDirs: []string{},
		CWD:              cwd,
		Mode:             model.ModeCode,
		AccessScope:      model.ScopeSystem,
		RunState:         model.RunIdle,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := c.store.SaveSession(ctx, session); err != nil {
		return err
	}
	if err := c.store.SetCurrentSessionID(ctx, session.SessionID); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, fmt.Sprintf("Created and switched to %s\ncwd: %s\nscope: %s", session.SessionID, session.CWD, session.AccessScope), nil)
	return err
}

func (c *Coordinator) commandReset(ctx context.Context, chatID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, "No session is selected. Run /new first.", nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	session.CodexThreadID = ""
	session.RollingSummary = ""
	session.RunState = model.RunIdle
	session.CancellationResult = ""
	session.ActiveRunID = ""
	session.StaleRecovered = false
	session.LastError = ""
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, "Current session reset.", nil)
	return err
}

func (c *Coordinator) commandCD(ctx context.Context, chatID, requested string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, "No session is selected. Run /new first.", nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	next, err := policy.ResolveDirectory(*session, requested)
	if err != nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, err.Error(), nil)
		return sendErr
	}
	session.CWD = next
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, "Updated cwd to "+next, nil)
	return err
}

func (c *Coordinator) commandMode(ctx context.Context, chatID string, args []string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, "No session is selected. Run /new first.", nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if len(args) == 0 {
		_, err := c.tg.SendMessage(ctx, chatID, "Current mode: "+string(session.Mode), nil)
		return err
	}
	switch args[0] {
	case string(model.ModeAsk), string(model.ModePlan), string(model.ModeCode):
		session.Mode = model.SessionMode(args[0])
	default:
		_, err := c.tg.SendMessage(ctx, chatID, "Usage: /mode <ask|plan|code>", nil)
		return err
	}
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, "Mode updated to "+string(session.Mode), nil)
	return err
}

func (c *Coordinator) commandScope(ctx context.Context, chatID string, args []string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, "No session is selected. Run /new first.", nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if len(args) == 0 {
		_, err := c.tg.SendMessage(ctx, chatID, "Current scope: "+string(session.AccessScope), nil)
		return err
	}
	switch args[0] {
	case string(model.ScopeWorkspace), string(model.ScopeSystem):
		session.AccessScope = model.SessionAccessScope(args[0])
	default:
		_, err := c.tg.SendMessage(ctx, chatID, "Usage: /scope [workspace|system]", nil)
		return err
	}
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, "Scope updated to "+string(session.AccessScope), nil)
	return err
}

func (c *Coordinator) commandStatus(ctx context.Context, chatID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, "No session is selected. Run /new first.", nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	text := fmt.Sprintf("session: %s\ncwd: %s\nmode: %s\nscope: %s\nrun_state: %s\nthread: %s", session.SessionID, session.CWD, session.Mode, session.AccessScope, session.RunState, emptyFallback(session.CodexThreadID, "-"))
	_, err = c.tg.SendMessage(ctx, chatID, text, nil)
	return err
}

func (c *Coordinator) commandStop(ctx context.Context, chatID string) error {
	if c.active == nil {
		_, err := c.tg.SendMessage(ctx, chatID, "No active run.", nil)
		return err
	}
	c.active.StopRequested = true
	session, _ := c.store.GetSession(ctx, c.active.SessionID)
	if c.active.Runner != nil {
		c.active.LastCancel = c.active.Runner.Cancel()
	} else {
		c.active.LastCancel = model.CancelPartial
	}
	if session != nil {
		if c.active.PendingActionID != "" {
			session.RunState = model.RunCancelled
			session.ActiveRunID = ""
			session.LastError = ""
			_ = c.store.ResolvePendingAction(ctx, c.active.PendingActionID, string(model.ResolutionDenied))
			c.cleanupActiveRun()
		} else {
			session.RunState = model.RunCancelling
		}
		session.UpdatedAt = time.Now().UTC()
		_ = c.store.SaveSession(ctx, *session)
	}
	_, err := c.tg.SendMessage(ctx, chatID, "Requested cancellation for the current run.", nil)
	return err
}

func (c *Coordinator) commandPerm(ctx context.Context, chatID, userID string, args []string) error {
	if len(args) >= 2 && (args[0] == "approve" || args[0] == "deny") {
		return c.resolveApproval(ctx, chatID, userID, args[1], args[0] == "approve")
	}
	actions, err := c.store.ListPendingActions(ctx, true)
	if err != nil {
		return err
	}
	if len(actions) == 0 {
		_, err := c.tg.SendMessage(ctx, chatID, "No pending approvals.", nil)
		return err
	}
	lines := []string{"Pending approvals:"}
	for _, action := range actions {
		lines = append(lines, fmt.Sprintf("%s: %s", action.ActionID, action.Payload["summary"]))
	}
	_, err = c.tg.SendMessage(ctx, chatID, strings.Join(lines, "\n"), nil)
	return err
}

func (c *Coordinator) commandThink(ctx context.Context, chatID string, args []string) error {
	if len(args) == 0 {
		current, err := codex.ReadReasoningEffort(c.cfg.CodexHome)
		if err != nil {
			return err
		}
		if current == "" {
			current = "unset"
		}
		_, err = c.tg.SendMessage(ctx, chatID, "Current think level: "+current, nil)
		return err
	}
	requested := strings.TrimSpace(args[0])
	if !codex.IsReasoningEffort(requested) {
		_, err := c.tg.SendMessage(ctx, chatID, "Usage: /think [minimal|low|medium|high|xhigh]", nil)
		return err
	}
	if err := codex.WriteReasoningEffort(c.cfg.CodexHome, requested); err != nil {
		return err
	}
	_, err := c.tg.SendMessage(ctx, chatID, "Updated think level to "+requested+".", nil)
	return err
}

func (c *Coordinator) handleUserInput(ctx context.Context, chatID, userID string, message *telegram.Message) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, "No session is selected. Run /new first.", nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if c.active != nil || session.RunState == model.RunRunning || session.RunState == model.RunWaitingApproval || session.RunState == model.RunCancelling {
		_, err := c.tg.SendMessage(ctx, chatID, "This session is already busy. Use /stat or /stop.", nil)
		return err
	}

	prompt := strings.TrimSpace(message.Text)
	if prompt == "" {
		prompt = strings.TrimSpace(message.Caption)
	}
	var images []string
	var cleanups []func()
	if len(message.Photo) > 0 {
		best := message.Photo[len(message.Photo)-1]
		path, cleanup, err := c.tg.DownloadToTemp(ctx, best.FileID, "photo.jpg", c.cfg.TempDir)
		if err != nil {
			return err
		}
		images = append(images, path)
		cleanups = append(cleanups, cleanup)
	}
	if message.Document != nil && strings.HasPrefix(message.Document.MimeType, "image/") {
		name := message.Document.FileName
		if name == "" {
			name = "document-image"
		}
		path, cleanup, err := c.tg.DownloadToTemp(ctx, message.Document.FileID, name, c.cfg.TempDir)
		if err != nil {
			return err
		}
		images = append(images, path)
		cleanups = append(cleanups, cleanup)
	}
	if prompt == "" && len(images) > 0 {
		prompt = "Please inspect the provided image."
	}
	if prompt == "" {
		return nil
	}

	_ = c.store.AppendAudit(ctx, model.AuditRecord{
		SessionID: session.SessionID,
		ChatID:    chatID,
		EventType: "user_input",
		Payload: map[string]any{
			"text_length": len(prompt),
			"images":      len(images),
		},
	})
	return c.startRun(ctx, *session, chatID, userID, prompt, images, cleanups)
}

func (c *Coordinator) startRun(ctx context.Context, session model.Session, chatID, userID, prompt string, images []string, cleanups []func()) error {
	previewID, err := c.tg.SendMessage(ctx, chatID, "Running Codex...", nil)
	if err != nil {
		return err
	}

	runID := "run-" + randomID()
	session.RunState = model.RunRunning
	session.ActiveRunID = runID
	session.LastError = ""
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, session); err != nil {
		return err
	}

	run := codex.Start(ctx, codex.Options{
		Executable:     c.cfg.CodexExecutable,
		Prompt:         prompt,
		ResumeThreadID: session.CodexThreadID,
		RollingSummary: session.RollingSummary,
		CWD:            session.CWD,
		Mode:           session.Mode,
		ExtraWritable:  policy.AllowedPaths(session),
		Images:         images,
	})

	active := &activeRun{
		SessionID:        session.SessionID,
		RunID:            runID,
		ChatID:           chatID,
		UserID:           userID,
		PreviewMessageID: previewID,
		Runner:           run,
		Cleanup:          cleanups,
	}
	c.active = active

	go func(runID string, runner *codex.Run) {
		for event := range runner.Events {
			c.events <- codexEvent{RunID: runID, Event: event}
		}
	}(runID, run)
	go func(runID string, runner *codex.Run) {
		if result, ok := <-runner.Result; ok {
			c.events <- runFinished{RunID: runID, Result: result}
		}
	}(runID, run)

	return nil
}

func (c *Coordinator) handleCodexEvent(ctx context.Context, runID string, event codex.Event) error {
	if c.active == nil || c.active.RunID != runID {
		return nil
	}
	session, err := c.store.GetSession(ctx, c.active.SessionID)
	if err != nil || session == nil {
		return err
	}

	switch event.Kind {
	case codex.EventThreadStarted:
		session.CodexThreadID = event.ThreadID
		session.UpdatedAt = time.Now().UTC()
		return c.store.SaveSession(ctx, *session)
	case codex.EventAgentMessage:
		_ = c.store.AppendAudit(ctx, model.AuditRecord{
			SessionID: session.SessionID,
			ChatID:    c.active.ChatID,
			RunID:     c.active.RunID,
			EventType: "agent_text",
			Payload: map[string]any{
				"text_length": len(event.Text),
			},
		})
		return c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, event.Text)
	case codex.EventApprovalRequest:
		if c.active.PendingActionID != "" {
			return nil
		}
		actionID := "action-" + randomID()
		if err := c.store.CreatePendingAction(ctx, model.PendingAction{
			ActionID:        actionID,
			ActionType:      "approval",
			SessionID:       session.SessionID,
			RunID:           c.active.RunID,
			ChatID:          c.active.ChatID,
			UserID:          c.active.UserID,
			SourceMessageID: fmt.Sprintf("%d", c.active.PreviewMessageID),
			Payload: map[string]string{
				"toolName": "exec_command",
				"summary":  event.Summary,
			},
			ExpiresAt: time.Now().UTC().Add(15 * time.Minute),
		}); err != nil {
			return err
		}
		c.active.PendingActionID = actionID
		session.RunState = model.RunWaitingApproval
		session.UpdatedAt = time.Now().UTC()
		if err := c.store.SaveSession(ctx, *session); err != nil {
			return err
		}
		if err := c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, "Waiting for approval: "+event.Summary); err != nil {
			c.logger.Warn("preview update failed", "err", err)
		}
		_, err := c.tg.SendMessage(ctx, c.active.ChatID, "Codex needs approval before it can continue.\nCommand: "+event.Summary+"\nPermission ID: "+actionID, &telegram.InlineKeyboardMarkup{
			InlineKeyboard: [][]telegram.InlineKeyboardButton{{
				{Text: "Approve", CallbackData: "pa:" + actionID},
				{Text: "Deny", CallbackData: "pd:" + actionID},
			}},
		})
		if err != nil {
			return err
		}
		c.active.LastCancel = c.active.Runner.Cancel()
	case codex.EventExecBegin:
		_ = c.store.AppendAudit(ctx, model.AuditRecord{
			SessionID: session.SessionID,
			ChatID:    c.active.ChatID,
			RunID:     c.active.RunID,
			EventType: "tool_start",
			Payload: map[string]any{
				"command": strings.Join(event.Command, " "),
			},
		})
	case codex.EventExecEnd:
		_ = c.store.AppendAudit(ctx, model.AuditRecord{
			SessionID: session.SessionID,
			ChatID:    c.active.ChatID,
			RunID:     c.active.RunID,
			EventType: "tool_result",
			Payload: map[string]any{
				"command":  strings.Join(event.Command, " "),
				"exitCode": event.ExitCode,
				"status":   event.Status,
			},
		})
	case codex.EventPatchBegin:
		_ = c.store.AppendAudit(ctx, model.AuditRecord{
			SessionID: session.SessionID,
			ChatID:    c.active.ChatID,
			RunID:     c.active.RunID,
			EventType: "file_change",
			Payload: map[string]any{
				"paths": strings.Join(event.ChangedPaths, ", "),
			},
		})
	}
	return nil
}

func (c *Coordinator) handleRunFinished(ctx context.Context, runID string, result codex.Result) error {
	if c.active == nil || c.active.RunID != runID {
		return nil
	}

	session, err := c.store.GetSession(ctx, c.active.SessionID)
	if err != nil || session == nil {
		return err
	}
	if c.active.PendingActionID != "" {
		c.active.Runner = nil
		return nil
	}

	defer c.cleanupActiveRun()

	if c.active.StopRequested {
		session.RunState = model.RunCancelled
		session.CancellationResult = string(c.active.LastCancel)
		session.ActiveRunID = ""
		session.LastError = ""
		session.UpdatedAt = time.Now().UTC()
		_ = c.store.AppendAudit(ctx, model.AuditRecord{
			SessionID: session.SessionID,
			ChatID:    c.active.ChatID,
			RunID:     c.active.RunID,
			EventType: "run_cancel",
			Payload: map[string]any{
				"result": c.active.LastCancel,
			},
		})
		if err := c.store.SaveSession(ctx, *session); err != nil {
			return err
		}
		return c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, result.FinalMessage)
	}

	session.ActiveRunID = ""
	session.UpdatedAt = time.Now().UTC()
	if result.StaleRecovered {
		session.StaleRecovered = true
		_ = c.store.AppendAudit(ctx, model.AuditRecord{
			SessionID: session.SessionID,
			ChatID:    c.active.ChatID,
			RunID:     c.active.RunID,
			EventType: "resume_recovery",
			Payload: map[string]any{
				"used_summary_seed": result.UsedSummarySeed,
			},
		})
	}
	if result.ExitCode == 0 {
		session.RunState = model.RunIdle
		session.LastError = ""
	} else {
		session.RunState = model.RunFailed
		session.LastError = result.FinalMessage
	}
	if audits, err := c.store.ListRecentAudit(ctx, session.SessionID, 12); err == nil {
		session.RollingSummary = policy.BuildRollingSummary(audits)
	}
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	return c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, result.FinalMessage)
}

func (c *Coordinator) resolveApproval(ctx context.Context, chatID, userID, actionID string, approve bool) error {
	action, err := c.store.GetPendingAction(ctx, actionID)
	if err != nil || action == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, "Pending approval not found.", nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if action.Resolved {
		_, err := c.tg.SendMessage(ctx, chatID, "This approval has already been handled.", nil)
		return err
	}
	if action.UserID != "" && action.UserID != userID {
		_, err := c.tg.SendMessage(ctx, chatID, "This approval does not belong to the current user.", nil)
		return err
	}

	if approve {
		if err := c.store.ResolvePendingAction(ctx, actionID, string(model.ResolutionApproved)); err != nil {
			return err
		}
		_ = c.store.AppendAudit(ctx, model.AuditRecord{
			SessionID: action.SessionID,
			ChatID:    chatID,
			RunID:     action.RunID,
			EventType: "approval_decision",
			Payload: map[string]any{
				"actionId":   actionID,
				"decision":   "approve",
				"resolution": "approved",
			},
		})
		session, err := c.store.GetSession(ctx, action.SessionID)
		if err != nil || session == nil {
			return err
		}
		summary := action.Payload["summary"]
		if c.active != nil && c.active.PendingActionID == actionID {
			c.cleanupActiveRun()
		}
		_, _ = c.tg.SendMessage(ctx, chatID, "Approval granted.", nil)
		return c.startRun(ctx, *session, action.ChatID, action.UserID, policy.BuildResumePrompt(summary), nil, nil)
	}

	if err := c.store.ResolvePendingAction(ctx, actionID, string(model.ResolutionDenied)); err != nil {
		return err
	}
	_ = c.store.AppendAudit(ctx, model.AuditRecord{
		SessionID: action.SessionID,
		ChatID:    chatID,
		RunID:     action.RunID,
		EventType: "approval_decision",
		Payload: map[string]any{
			"actionId":   actionID,
			"decision":   "deny",
			"resolution": "denied",
		},
	})
	session, _ := c.store.GetSession(ctx, action.SessionID)
	if session != nil {
		session.RunState = model.RunFailed
		session.ActiveRunID = ""
		session.LastError = "Approval denied."
		session.UpdatedAt = time.Now().UTC()
		_ = c.store.SaveSession(ctx, *session)
	}
	if c.active != nil && c.active.PendingActionID == actionID {
		c.cleanupActiveRun()
	}
	_, err = c.tg.SendMessage(ctx, chatID, "Approval denied.", nil)
	return err
}

func (c *Coordinator) expirePendingActions(ctx context.Context) error {
	expired, err := c.store.ExpirePendingActions(ctx, time.Now().UTC())
	if err != nil {
		return err
	}
	for _, action := range expired {
		session, _ := c.store.GetSession(ctx, action.SessionID)
		if session != nil {
			session.RunState = model.RunFailed
			session.ActiveRunID = ""
			session.LastError = "Approval expired."
			session.UpdatedAt = time.Now().UTC()
			_ = c.store.SaveSession(ctx, *session)
		}
		if action.ChatID != "" {
			_, _ = c.tg.SendMessage(ctx, action.ChatID, "Approval expired. The run was stopped.", nil)
		}
		if c.active != nil && c.active.PendingActionID == action.ActionID {
			c.cleanupActiveRun()
		}
	}
	return nil
}

func (c *Coordinator) helpText() string {
	return strings.Join([]string{
		"Supported commands:",
		"/start",
		"/help",
		"/new [cwd]",
		"/reset",
		"/cd <path>",
		"/mode <ask|plan|code>",
		"/scope [workspace|system]",
		"/think",
		"/ctx",
		"/stat",
		"/stop",
		"/perm",
		"/perm approve <id>",
		"/perm deny <id>",
	}, "\n")
}

func (c *Coordinator) cleanupActiveRun() {
	if c.active == nil {
		return
	}
	for _, cleanup := range c.active.Cleanup {
		cleanup()
	}
	c.active = nil
}

func (c *Coordinator) stopActiveRun() {
	if c.active != nil && c.active.Runner != nil {
		c.active.Runner.Cancel()
	}
}

func (c *Coordinator) currentSessionID(ctx context.Context) string {
	value, _ := c.store.GetCurrentSessionID(ctx)
	return value
}

func randomID() string {
	var raw [8]byte
	_, _ = rand.Read(raw[:])
	return hex.EncodeToString(raw[:])
}

func emptyFallback(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
