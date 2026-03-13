package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
	"sync"
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

	events   chan any
	active   *activeRun
	observer Observer

	seenMu        sync.Mutex
	seenMessages  map[string]time.Time
	seenCallbacks map[string]time.Time
}

type activeRun struct {
	SessionID        string
	RunID            string
	ChatID           string
	UserID           string
	Prompt           string
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

type Observer interface {
	PollStarted(offset int64)
	PollSucceeded(previousOffset, currentOffset int64, updateCount int)
	PollFailed(err error)
	UpdateHandled(updateID int64)
	RunStarted(sessionID, runID string)
	RunFinished(sessionID, runID string, result codex.Result)
	ApprovalRequested(sessionID, runID, actionID, summary string)
}

func NewCoordinator(cfg config.Config, logger *slog.Logger, store *store.Store, tg *telegram.Client) *Coordinator {
	return &Coordinator{
		cfg:           cfg,
		logger:        logger,
		store:         store,
		tg:            tg,
		events:        make(chan any, 256),
		seenMessages:  map[string]time.Time{},
		seenCallbacks: map[string]time.Time{},
	}
}

func (c *Coordinator) SetObserver(observer Observer) {
	c.observer = observer
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
				if c.observer != nil {
					c.observer.UpdateHandled(typed.Update.UpdateID)
				}
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
			c.pruneSeenEntries(time.Now().UTC().Add(-15 * time.Minute))
			if err := c.expirePendingActions(ctx); err != nil {
				c.logger.Warn("expire approvals failed", "err", err)
			}
			_ = c.store.Cleanup(ctx, time.Now().AddDate(0, 0, -c.cfg.ResolvedApprovalRetentionDays), time.Now().AddDate(0, 0, -c.cfg.ExpiredApprovalRetentionDays), c.cfg.MaxAuditRows)
		}
	}
}

func (c *Coordinator) pollTelegram(ctx context.Context) {
	offset, err := c.store.GetTelegramOffset(ctx)
	if err != nil {
		c.logger.Warn("read telegram offset failed", "err", err)
		offset = 0
	}

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if c.observer != nil {
			c.observer.PollStarted(offset)
		}
		updates, err := c.tg.GetUpdates(ctx, offset, 30)
		if err != nil {
			if c.observer != nil {
				c.observer.PollFailed(err)
			}
			c.logger.Warn("telegram getUpdates failed", "err", err)
			time.Sleep(2 * time.Second)
			continue
		}
		previousOffset := offset
		currentOffset := offset
		if len(updates) > 0 {
			currentOffset = updates[len(updates)-1].UpdateID + 1
		}
		if currentOffset != offset {
			if err := c.store.SetTelegramOffset(ctx, currentOffset); err != nil {
				c.logger.Warn("persist telegram offset failed", "err", err)
				time.Sleep(2 * time.Second)
				continue
			}
			offset = currentOffset
		}
		if c.observer != nil {
			c.observer.PollSucceeded(previousOffset, currentOffset, len(updates))
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
	if c.markMessageSeen(chatID, message.MessageID) {
		return nil
	}
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
		_, _ = c.tg.SendMessage(ctx, chatID, localize(auth.PreferredLanguage, "Too many incorrect attempts. This Telegram user ID has been blocked locally.", "密码错误次数过多，这个 Telegram 用户 ID 已被本地封禁。"), nil)
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
	if c.markCallbackSeen(callback.ID) {
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
		if !c.isAuthorizedForLanguageSelection(auth) {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		language := strings.TrimPrefix(data, "lang:")
		if language != "zh" && language != "en" {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Unknown language.", "未知语言。"), true)
		}
		if err := c.store.SetPreferredLanguage(ctx, userID, chatID, language); err != nil {
			return err
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(language, "Language saved.", "语言已保存。"), false); err != nil {
			return err
		}
		_, _ = c.tg.SendMessage(ctx, chatID, localize(language, "Language saved. You can now use /new and start chatting.", "语言已保存。现在可以使用 /new 开始聊天。"), nil)
		return nil
	case strings.HasPrefix(data, "pa:"):
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Received.", "已收到。"), false); err != nil {
			return err
		}
		return c.resolveApproval(ctx, chatID, userID, strings.TrimPrefix(data, "pa:"), true)
	case strings.HasPrefix(data, "pd:"):
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Received.", "已收到。"), false); err != nil {
			return err
		}
		return c.resolveApproval(ctx, chatID, userID, strings.TrimPrefix(data, "pd:"), false)
	case strings.HasPrefix(data, "pc:"):
		actionID, optionIndex, ok := parsePlanChoiceCallback(data)
		if !ok {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Invalid plan option.", "无效的规划选项。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Continuing with that plan.", "将按这个方案继续。"), false); err != nil {
			return err
		}
		return c.resolvePlanChoice(ctx, chatID, userID, actionID, optionIndex)
	case strings.HasPrefix(data, "pr:"):
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Replanning.", "正在重新规划。"), false); err != nil {
			return err
		}
		return c.retryPlanChoice(ctx, chatID, userID, strings.TrimPrefix(data, "pr:"))
	default:
		return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Expired or already handled.", "已过期或已经处理过。"), true)
	}
}

func (c *Coordinator) handleVerificationAndLanguage(ctx context.Context, auth *model.TelegramUserAuth, message *telegram.Message) (bool, error) {
	chatID := fmt.Sprintf("%d", message.Chat.ID)
	userID := fmt.Sprintf("%d", message.From.ID)
	text := strings.TrimSpace(message.Text)

	if c.requiresVerification() && auth.VerifiedAt == nil {
		if strings.HasPrefix(text, "/start") {
			_, err := c.tg.SendMessage(ctx, chatID, "Welcome. Please send the verification password in your next message to confirm your identity.\n\n欢迎使用。请在下一条消息中发送验证密码以确认身份。", nil)
			return true, err
		}
		if text == "" || strings.HasPrefix(text, "/") {
			_, err := c.tg.SendMessage(ctx, chatID, "Please send the verification password first.\n\n请先发送验证密码。", nil)
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
		message := "Incorrect password. Please try again.\n\n密码错误，请重试。"
		if updated.BannedAt != nil {
			message = "Too many incorrect attempts. This Telegram user ID has been blocked locally.\n\n密码错误次数过多，这个 Telegram 用户 ID 已被本地封禁。"
		}
		_, err = c.tg.SendMessage(ctx, chatID, message, nil)
		return true, err
	}

	if auth.PreferredLanguage == "" && c.isAuthorizedForLanguageSelection(auth) {
		if strings.HasPrefix(text, "/start") {
			return true, c.sendLanguagePicker(ctx, chatID)
		}
		if !c.requiresVerification() {
			return false, nil
		}
		_, err := c.tg.SendMessage(ctx, chatID, "Please choose your prompt language first.\n\n请先选择提示语言。", &telegram.InlineKeyboardMarkup{
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
	_, err := c.tg.SendMessage(ctx, chatID, "Please choose your prompt language.\n\n请选择提示语言。", &telegram.InlineKeyboardMarkup{
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
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Codex + Telegram Bridge is available. Use /new to create a session or /help to see commands.", "Codex + Telegram Bridge 已可用。使用 /new 创建会话，或用 /help 查看命令。"), nil)
		return err
	case "/help":
		_, err := c.tg.SendMessage(ctx, chatID, c.helpText(ctx, userID, chatID), nil)
		return err
	case "/new":
		return c.commandNew(ctx, chatID, userID, args)
	case "/reset":
		return c.commandReset(ctx, chatID, userID)
	case "/cd":
		if len(args) == 0 {
			_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Usage: /cd <path>", "用法：/cd <路径>"), nil)
			return err
		}
		return c.commandCD(ctx, chatID, userID, strings.Join(args, " "))
	case "/mode":
		return c.commandMode(ctx, chatID, userID, args)
	case "/scope":
		return c.commandScope(ctx, chatID, userID, args)
	case "/ctx":
		return c.commandContext(ctx, chatID, userID)
	case "/stat":
		return c.commandStatus(ctx, chatID, userID)
	case "/stop":
		return c.commandStop(ctx, chatID, userID)
	case "/think":
		return c.commandThink(ctx, chatID, userID, args)
	default:
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Unsupported command.", "不支持的命令。"), nil)
		return err
	}
}

func (c *Coordinator) commandNew(ctx context.Context, chatID, userID string, args []string) error {
	root, err := policy.ValidateWorkspaceRoot(c.cfg.DefaultWorkspaceRoot)
	if err != nil {
		return err
	}
	cwd := root
	if len(args) > 0 {
		probe := model.Session{
			WorkspaceRoot: root,
			CWD:           root,
			AccessScope:   model.ScopeWorkspace,
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
		AccessScope:      model.ScopeWorkspace,
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
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Created and switched to %s\ncwd: %s\nscope: %s", "已创建并切换到 %s\n目录: %s\n范围: %s", session.SessionID, session.CWD, session.AccessScope), nil)
	return err
}

func (c *Coordinator) commandReset(ctx context.Context, chatID, userID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No session is selected. Run /new first.", "当前没有选中的会话，请先执行 /new。"), nil)
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
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Current session reset.", "当前会话已重置。"), nil)
	return err
}

func (c *Coordinator) commandCD(ctx context.Context, chatID, userID, requested string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No session is selected. Run /new first.", "当前没有选中的会话，请先执行 /new。"), nil)
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
	c.resetSessionExecutionContext(session)
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Updated cwd to %s\nCodex thread reset so the next run starts from the new directory.", "当前目录已更新为 %s\nCodex 线程已重置，下一次运行会从新目录开始。", next), nil)
	return err
}

func (c *Coordinator) commandMode(ctx context.Context, chatID, userID string, args []string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No session is selected. Run /new first.", "当前没有选中的会话，请先执行 /new。"), nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if len(args) == 0 {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Current mode: %s", "当前模式：%s", modeLabel(c.preferredLanguage(ctx, userID, chatID), session.Mode)), nil)
		return err
	}
	switch args[0] {
	case string(model.ModeAsk), string(model.ModePlan), string(model.ModeCode):
		session.Mode = model.SessionMode(args[0])
	default:
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Usage: /mode <ask|plan|code>", "用法：/mode <ask|plan|code>"), nil)
		return err
	}
	c.resetSessionExecutionContext(session)
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Mode updated to %s\nCodex thread reset so the next run uses the new mode.", "模式已更新为 %s\nCodex 线程已重置，下一次运行会使用新模式。", modeLabel(c.preferredLanguage(ctx, userID, chatID), session.Mode)), nil)
	return err
}

func (c *Coordinator) commandScope(ctx context.Context, chatID, userID string, args []string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No session is selected. Run /new first.", "当前没有选中的会话，请先执行 /new。"), nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if len(args) == 0 {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Current scope: %s", "当前范围：%s", scopeLabel(c.preferredLanguage(ctx, userID, chatID), session.AccessScope)), nil)
		return err
	}
	switch args[0] {
	case string(model.ScopeWorkspace), string(model.ScopeSystem):
		session.AccessScope = model.SessionAccessScope(args[0])
	default:
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Usage: /scope [workspace|system]", "用法：/scope [workspace|system]"), nil)
		return err
	}
	c.resetSessionExecutionContext(session)
	session.UpdatedAt = time.Now().UTC()
	if err := c.store.SaveSession(ctx, *session); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Scope updated to %s\nCodex thread reset so the next run uses the new scope.", "范围已更新为 %s\nCodex 线程已重置，下一次运行会使用新范围。", scopeLabel(c.preferredLanguage(ctx, userID, chatID), session.AccessScope)), nil)
	return err
}

func (c *Coordinator) commandContext(ctx context.Context, chatID, userID string) error {
	info, err := codex.ReadRuntimeInfo(c.cfg.CodexHome)
	if err != nil {
		return err
	}
	session, _ := c.store.GetCurrentSession(ctx)
	lines := []string{}
	language := c.preferredLanguage(ctx, userID, chatID)
	if normalizeLanguage(language) == "zh" {
		lines = append(lines, "Codex 运行上下文：")
		lines = append(lines, fmt.Sprintf("模型: %s", emptyFallback(info.Model, "unknown")))
		lines = append(lines, fmt.Sprintf("推理强度: %s", emptyFallback(info.ReasoningEffort, "unknown")))
		if info.ContextWindow > 0 {
			lines = append(lines, fmt.Sprintf("上下文窗口剩余: %d / %d", info.ContextRemaining, info.ContextWindow))
		}
		if !info.PrimaryResetsAt.IsZero() {
			lines = append(lines, fmt.Sprintf("5 小时限额剩余: %s (重置于 %s)", codex.FormatWindowRemaining(info.PrimaryUsedPercent), info.PrimaryResetsAt.Format(time.RFC3339)))
		}
		if !info.SecondaryResetsAt.IsZero() {
			lines = append(lines, fmt.Sprintf("周限额剩余: %s (重置于 %s)", codex.FormatWindowRemaining(info.SecondaryUsedPercent), info.SecondaryResetsAt.Format(time.RFC3339)))
		}
		if session != nil {
			lines = append(lines, "")
			lines = append(lines, "当前 bridge 会话：")
			lines = append(lines, fmt.Sprintf("会话: %s", session.SessionID))
			lines = append(lines, fmt.Sprintf("目录: %s", session.CWD))
			lines = append(lines, fmt.Sprintf("模式: %s", modeLabel(language, session.Mode)))
			lines = append(lines, fmt.Sprintf("范围: %s", scopeLabel(language, session.AccessScope)))
		}
	} else {
		lines = append(lines, "Codex runtime context:")
		lines = append(lines, fmt.Sprintf("model: %s", emptyFallback(info.Model, "unknown")))
		lines = append(lines, fmt.Sprintf("reasoning_effort: %s", emptyFallback(info.ReasoningEffort, "unknown")))
		if info.ContextWindow > 0 {
			lines = append(lines, fmt.Sprintf("context_remaining: %d / %d", info.ContextRemaining, info.ContextWindow))
		}
		if !info.PrimaryResetsAt.IsZero() {
			lines = append(lines, fmt.Sprintf("5h_window_remaining: %s (resets_at: %s)", codex.FormatWindowRemaining(info.PrimaryUsedPercent), info.PrimaryResetsAt.Format(time.RFC3339)))
		}
		if !info.SecondaryResetsAt.IsZero() {
			lines = append(lines, fmt.Sprintf("weekly_window_remaining: %s (resets_at: %s)", codex.FormatWindowRemaining(info.SecondaryUsedPercent), info.SecondaryResetsAt.Format(time.RFC3339)))
		}
		if session != nil {
			lines = append(lines, "")
			lines = append(lines, "Current bridge session:")
			lines = append(lines, fmt.Sprintf("session: %s", session.SessionID))
			lines = append(lines, fmt.Sprintf("cwd: %s", session.CWD))
			lines = append(lines, fmt.Sprintf("mode: %s", modeLabel(language, session.Mode)))
			lines = append(lines, fmt.Sprintf("scope: %s", scopeLabel(language, session.AccessScope)))
		}
	}
	_, err = c.tg.SendMessage(ctx, chatID, strings.Join(lines, "\n"), nil)
	return err
}

func (c *Coordinator) commandStatus(ctx context.Context, chatID, userID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No session is selected. Run /new first.", "当前没有选中的会话，请先执行 /new。"), nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	text := statusText(c.preferredLanguage(ctx, userID, chatID), *session)
	_, err = c.tg.SendMessage(ctx, chatID, text, nil)
	return err
}

func (c *Coordinator) commandStop(ctx context.Context, chatID, userID string) error {
	if c.active == nil {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No active run.", "当前没有正在运行的任务。"), nil)
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
	_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Requested cancellation for the current run.", "已经请求取消当前运行。"), nil)
	return err
}

func (c *Coordinator) commandThink(ctx context.Context, chatID, userID string, args []string) error {
	if len(args) == 0 {
		current, err := codex.ReadReasoningEffort(c.cfg.CodexHome)
		if err != nil {
			return err
		}
		if current == "" {
			current = "unset"
		}
		_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Current think level: %s", "当前思考强度：%s", current), nil)
		return err
	}
	requested := strings.TrimSpace(args[0])
	if !codex.IsReasoningEffort(requested) {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Usage: /think [minimal|low|medium|high|xhigh]", "用法：/think [minimal|low|medium|high|xhigh]"), nil)
		return err
	}
	if err := codex.WriteReasoningEffort(c.cfg.CodexHome, requested); err != nil {
		return err
	}
	_, err := c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Updated think level to %s.", "思考强度已更新为 %s。", requested), nil)
	return err
}

func (c *Coordinator) handleUserInput(ctx context.Context, chatID, userID string, message *telegram.Message) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No session is selected. Run /new first.", "当前没有选中的会话，请先执行 /new。"), nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if c.active != nil || session.RunState == model.RunRunning || session.RunState == model.RunWaitingApproval || session.RunState == model.RunCancelling {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "This session is already busy. Use /stat or /stop.", "当前会话正忙，请使用 /stat 或 /stop。"), nil)
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
		prompt = c.localizedText(ctx, userID, chatID, "Please inspect the provided image.", "请检查我提供的图片。")
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
	previewID, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Running Codex...", "Codex 正在运行..."), nil)
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

	options, optionCleanups, err := c.buildRunOptions(session, prompt, images)
	if err != nil {
		return err
	}
	cleanups = append(cleanups, optionCleanups...)
	run := codex.Start(ctx, options)

	active := &activeRun{
		SessionID:        session.SessionID,
		RunID:            runID,
		ChatID:           chatID,
		UserID:           userID,
		Prompt:           prompt,
		PreviewMessageID: previewID,
		Runner:           run,
		Cleanup:          cleanups,
	}
	c.active = active
	if c.observer != nil {
		c.observer.RunStarted(session.SessionID, runID)
	}

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
		if session.Mode == model.ModePlan {
			return c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, c.localizedText(ctx, c.active.UserID, c.active.ChatID, "Plan draft received. Preparing choices...", "已收到规划草案，正在整理选项..."))
		}
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
		if c.observer != nil {
			c.observer.ApprovalRequested(session.SessionID, c.active.RunID, actionID, event.Summary)
		}
		if err := c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, c.localizedTextf(ctx, c.active.UserID, c.active.ChatID, "Waiting for approval: %s", "等待审批：%s", event.Summary)); err != nil {
			c.logger.Warn("preview update failed", "err", err)
		}
		_, err := c.tg.SendMessage(ctx, c.active.ChatID, c.localizedTextf(ctx, c.active.UserID, c.active.ChatID, "Codex needs approval before it can continue.\nCommand: %s\nPermission ID: %s", "Codex 继续执行前需要审批。\n命令：%s\n审批 ID：%s", event.Summary, actionID), &telegram.InlineKeyboardMarkup{
			InlineKeyboard: [][]telegram.InlineKeyboardButton{{
				{Text: localize(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), "Approve", "批准"), CallbackData: "pa:" + actionID},
				{Text: localize(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), "Deny", "拒绝"), CallbackData: "pd:" + actionID},
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
	if c.observer != nil {
		c.observer.RunFinished(c.active.SessionID, c.active.RunID, result)
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
	if result.ExitCode == 0 && session.Mode == model.ModePlan {
		return c.presentPlanResult(ctx, *session, result)
	}
	return c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, result.FinalMessage)
}

func (c *Coordinator) resolveApproval(ctx context.Context, chatID, userID, actionID string, approve bool) error {
	action, err := c.store.GetPendingAction(ctx, actionID)
	if err != nil || action == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Pending approval not found.", "未找到待审批请求。"), nil)
		if err != nil {
			return err
		}
		return sendErr
	}
	if action.Resolved {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "This approval has already been handled.", "这个审批已经处理过了。"), nil)
		return err
	}
	if action.UserID != "" && action.UserID != userID {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "This approval does not belong to the current user.", "这个审批不属于当前用户。"), nil)
		return err
	}
	if model.PendingActionType(action.ActionType) == model.ActionPlanChoice {
		if approve {
			return c.resolvePlanChoice(ctx, chatID, userID, actionID, -1)
		}
		return c.retryPlanChoice(ctx, chatID, userID, actionID)
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
		_, _ = c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Approval granted.", "已批准。"), nil)
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
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Approval denied.", "已拒绝。"), nil)
	return err
}

func (c *Coordinator) resolvePlanChoice(ctx context.Context, chatID, userID, actionID string, optionIndex int) error {
	action, plan, session, err := c.loadPlanAction(ctx, chatID, userID, actionID)
	if err != nil || action == nil || session == nil {
		return err
	}
	if optionIndex < 0 {
		optionIndex = recommendedPlanOptionIndex(plan)
	}
	if optionIndex >= len(plan.Options) {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Plan option not found.", "未找到该规划选项。"), nil)
		return err
	}
	if err := c.store.ResolvePendingAction(ctx, actionID, string(model.ResolutionApproved)); err != nil {
		return err
	}
	selected := plan.Options[optionIndex]
	_ = c.store.AppendAudit(ctx, model.AuditRecord{
		SessionID: action.SessionID,
		ChatID:    chatID,
		RunID:     action.RunID,
		EventType: "plan_choice",
		Payload: map[string]any{
			"actionId": actionID,
			"option":   optionIndex + 1,
			"title":    selected.Title,
		},
	})
	_, _ = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Continuing with plan option %d: %s", "将按规划方案 %d 继续：%s", optionIndex+1, selected.Title), nil)
	return c.startRunWithMode(ctx, *session, action.ChatID, action.UserID, codex.BuildPlanExecutionPrompt(action.Payload["original_prompt"], plan, optionIndex), nil, nil, model.ModeCode)
}

func (c *Coordinator) retryPlanChoice(ctx context.Context, chatID, userID, actionID string) error {
	action, plan, session, err := c.loadPlanAction(ctx, chatID, userID, actionID)
	if err != nil || action == nil || session == nil {
		return err
	}
	if err := c.store.ResolvePendingAction(ctx, actionID, string(model.ResolutionDenied)); err != nil {
		return err
	}
	_ = c.store.AppendAudit(ctx, model.AuditRecord{
		SessionID: action.SessionID,
		ChatID:    chatID,
		RunID:     action.RunID,
		EventType: "plan_retry",
		Payload: map[string]any{
			"actionId": actionID,
		},
	})
	_, _ = c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Replanning with a different direction.", "将按不同方向重新规划。"), nil)
	return c.startRunWithMode(ctx, *session, action.ChatID, action.UserID, codex.BuildPlanRetryPrompt(action.Payload["original_prompt"], plan), nil, nil, model.ModePlan)
}

func (c *Coordinator) loadPlanAction(ctx context.Context, chatID, userID, actionID string) (*model.PendingAction, codex.PlanResponse, *model.Session, error) {
	action, err := c.store.GetPendingAction(ctx, actionID)
	if err != nil || action == nil {
		_, sendErr := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Pending plan choice not found.", "未找到待处理的规划选择。"), nil)
		if err != nil {
			return nil, codex.PlanResponse{}, nil, err
		}
		return nil, codex.PlanResponse{}, nil, sendErr
	}
	if action.Resolved {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "This plan choice has already been handled.", "这个规划选择已经处理过了。"), nil)
		return nil, codex.PlanResponse{}, nil, err
	}
	if model.PendingActionType(action.ActionType) != model.ActionPlanChoice {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "This action is not a plan choice.", "这个动作不是规划选择。"), nil)
		return nil, codex.PlanResponse{}, nil, err
	}
	if action.UserID != "" && action.UserID != userID {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "This plan choice does not belong to the current user.", "这个规划选择不属于当前用户。"), nil)
		return nil, codex.PlanResponse{}, nil, err
	}
	plan, err := codex.ParsePlanResponse(action.Payload["plan_json"])
	if err != nil {
		return nil, codex.PlanResponse{}, nil, err
	}
	session, err := c.store.GetSession(ctx, action.SessionID)
	if err != nil || session == nil {
		return nil, codex.PlanResponse{}, nil, err
	}
	return action, plan, session, nil
}

func (c *Coordinator) expirePendingActions(ctx context.Context) error {
	expired, err := c.store.ExpirePendingActions(ctx, time.Now().UTC())
	if err != nil {
		return err
	}
	for _, action := range expired {
		session, _ := c.store.GetSession(ctx, action.SessionID)
		if session != nil && model.PendingActionType(action.ActionType) != model.ActionPlanChoice {
			session.RunState = model.RunFailed
			session.ActiveRunID = ""
			session.LastError = "Approval expired."
			session.UpdatedAt = time.Now().UTC()
			_ = c.store.SaveSession(ctx, *session)
		}
		if action.ChatID != "" {
			if model.PendingActionType(action.ActionType) == model.ActionPlanChoice {
				_, _ = c.tg.SendMessage(ctx, action.ChatID, c.localizedText(ctx, action.UserID, action.ChatID, "Plan choice expired. Send the request again if you still want to continue.", "规划选择已过期。如果还想继续，请重新发送需求。"), nil)
			} else {
				_, _ = c.tg.SendMessage(ctx, action.ChatID, c.localizedText(ctx, action.UserID, action.ChatID, "Approval expired. The run was stopped.", "审批已过期，当前运行已停止。"), nil)
			}
		}
		if c.active != nil && c.active.PendingActionID == action.ActionID {
			c.cleanupActiveRun()
		}
	}
	return nil
}

func (c *Coordinator) buildRunOptions(session model.Session, prompt string, images []string) (codex.Options, []func(), error) {
	mode := session.Mode
	finalPrompt := prompt
	var cleanups []func()
	var outputSchemaPath string
	reasoningEffort, _ := codex.ReadReasoningEffort(c.cfg.CodexHome)
	approvalPolicy := c.cfg.CodexApprovalPolicy
	sandboxMode := c.cfg.CodexSandboxMode
	switch mode {
	case model.ModeAsk:
		finalPrompt = buildAskPrompt(prompt)
		approvalPolicy = "never"
		sandboxMode = "read-only"
	case model.ModePlan:
		approvalPolicy = "never"
		sandboxMode = "read-only"
	case model.ModeCode:
		if session.AccessScope == model.ScopeWorkspace {
			approvalPolicy = "never"
			sandboxMode = "workspace-write"
		}
	}
	if mode == model.ModePlan {
		finalPrompt = codex.BuildPlanPrompt(prompt)
		schemaPath, cleanup, err := codex.WritePlanSchema(c.cfg.TempDir)
		if err != nil {
			return codex.Options{}, nil, err
		}
		outputSchemaPath = schemaPath
		cleanups = append(cleanups, cleanup)
		if planEffort, err := codex.ReadPlanReasoningEffort(c.cfg.CodexHome); err == nil && strings.TrimSpace(planEffort) != "" {
			reasoningEffort = planEffort
		}
	}
	return codex.Options{
		Executable:       c.cfg.CodexExecutable,
		Prompt:           finalPrompt,
		ResumeThreadID:   session.CodexThreadID,
		RollingSummary:   session.RollingSummary,
		CWD:              session.CWD,
		Mode:             mode,
		ReasoningEffort:  reasoningEffort,
		ApprovalPolicy:   approvalPolicy,
		SandboxMode:      sandboxMode,
		OutputSchemaPath: outputSchemaPath,
		ExtraWritable:    policy.AllowedPaths(session),
		Images:           images,
	}, cleanups, nil
}

func (c *Coordinator) startRunWithMode(ctx context.Context, session model.Session, chatID, userID, prompt string, images []string, cleanups []func(), mode model.SessionMode) error {
	originalMode := session.Mode
	session.Mode = mode
	err := c.startRun(ctx, session, chatID, userID, prompt, images, cleanups)
	session.Mode = originalMode
	return err
}

func (c *Coordinator) presentPlanResult(ctx context.Context, session model.Session, result codex.Result) error {
	plan, err := codex.ParsePlanResponse(result.FinalMessage)
	if err != nil {
		return c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, result.FinalMessage)
	}
	actionID := "action-" + randomID()
	if err := c.store.CreatePendingAction(ctx, model.PendingAction{
		ActionID:        actionID,
		ActionType:      string(model.ActionPlanChoice),
		SessionID:       session.SessionID,
		RunID:           c.active.RunID,
		ChatID:          c.active.ChatID,
		UserID:          c.active.UserID,
		SourceMessageID: fmt.Sprintf("%d", c.active.PreviewMessageID),
		Payload: map[string]string{
			"toolName":        "plan_mode",
			"summary":         plan.Summary,
			"plan_json":       codex.MarshalPlanResponse(plan),
			"original_prompt": strings.TrimSpace(c.active.Prompt),
		},
		ExpiresAt: time.Now().UTC().Add(30 * time.Minute),
	}); err != nil {
		return err
	}
	language := c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID)
	if err := c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, formatPlanMessage(language, plan)); err != nil {
		return err
	}
	_, err = c.tg.SendMessage(ctx, c.active.ChatID, c.localizedText(ctx, c.active.UserID, c.active.ChatID, "Choose a plan to continue:", "请选择一个方案继续："), buildPlanChoiceKeyboard(language, actionID, plan))
	return err
}

func (c *Coordinator) helpText(ctx context.Context, userID, chatID string) string {
	return commandHelpText(c.preferredLanguage(ctx, userID, chatID))
}

func (c *Coordinator) resetSessionExecutionContext(session *model.Session) {
	if session == nil {
		return
	}
	session.CodexThreadID = ""
	session.RollingSummary = ""
	session.ActiveRunID = ""
	session.StaleRecovered = false
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

func (c *Coordinator) markMessageSeen(chatID string, messageID int64) bool {
	key := fmt.Sprintf("%s:%d", chatID, messageID)
	now := time.Now().UTC()

	c.seenMu.Lock()
	defer c.seenMu.Unlock()

	_, exists := c.seenMessages[key]
	c.seenMessages[key] = now
	return exists
}

func (c *Coordinator) preferredLanguage(ctx context.Context, userID, chatID string) string {
	auth, err := c.store.GetOrCreateTelegramUserAuth(ctx, userID, chatID)
	if err != nil || auth == nil {
		return "en"
	}
	return normalizeLanguage(auth.PreferredLanguage)
}

func (c *Coordinator) localizedText(ctx context.Context, userID, chatID, english, chinese string) string {
	return localize(c.preferredLanguage(ctx, userID, chatID), english, chinese)
}

func (c *Coordinator) localizedTextf(ctx context.Context, userID, chatID, english, chinese string, args ...any) string {
	if c.preferredLanguage(ctx, userID, chatID) == "zh" {
		return fmt.Sprintf(chinese, args...)
	}
	return fmt.Sprintf(english, args...)
}

func (c *Coordinator) requiresVerification() bool {
	return strings.TrimSpace(c.cfg.VerificationPasswordHash) != ""
}

func (c *Coordinator) isAuthorizedForLanguageSelection(auth *model.TelegramUserAuth) bool {
	return !c.requiresVerification() || auth.VerifiedAt != nil
}

func (c *Coordinator) markCallbackSeen(callbackID string) bool {
	now := time.Now().UTC()

	c.seenMu.Lock()
	defer c.seenMu.Unlock()

	_, exists := c.seenCallbacks[callbackID]
	c.seenCallbacks[callbackID] = now
	return exists
}

func (c *Coordinator) pruneSeenEntries(cutoff time.Time) {
	c.seenMu.Lock()
	defer c.seenMu.Unlock()

	for key, seenAt := range c.seenMessages {
		if seenAt.Before(cutoff) {
			delete(c.seenMessages, key)
		}
	}
	for key, seenAt := range c.seenCallbacks {
		if seenAt.Before(cutoff) {
			delete(c.seenCallbacks, key)
		}
	}
}
