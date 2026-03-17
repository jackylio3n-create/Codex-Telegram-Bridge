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
	lastVacuumAt  time.Time
	lastCodexDBAt time.Time
}

type activeRun struct {
	SessionID        string
	RunID            string
	ChatID           string
	UserID           string
	Prompt           string
	PreviewMessageID int64
	StartedAt        time.Time
	LastPreviewAt    time.Time
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

type runHeartbeat struct {
	RunID string
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

	if err := c.runMaintenance(ctx, time.Now().UTC()); err != nil {
		c.logger.Warn("startup maintenance failed", "err", err)
	}

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
			case runHeartbeat:
				if err := c.handleRunHeartbeat(ctx, typed.RunID); err != nil {
					c.logger.Error("handle run heartbeat failed", "err", err)
				}
			}
		case <-ticker.C:
			now := time.Now().UTC()
			c.pruneSeenEntries(now.Add(-15 * time.Minute))
			if err := c.expirePendingActions(ctx); err != nil {
				c.logger.Warn("expire approvals failed", "err", err)
			}
			if err := c.runMaintenance(ctx, now); err != nil {
				c.logger.Warn("maintenance failed", "err", err)
			}
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
	authorized, err := c.ensureAuthorizedChat(ctx, chatID)
	if err != nil {
		return err
	}
	if !authorized {
		return nil
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
	authorized, err := c.ensureAuthorizedChat(ctx, chatID)
	if err != nil {
		return err
	}
	if !authorized {
		_ = c.tg.AnswerCallback(ctx, callback.ID, "Unauthorized.", true)
		return nil
	}
	auth, err := c.store.GetOrCreateTelegramUserAuth(ctx, userID, chatID)
	if err != nil {
		return err
	}
	if auth.BannedAt != nil {
		return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "This Telegram user has been blocked locally.", "这个 Telegram 用户已被本地封禁。"), true)
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
		if err := c.bindOwnerChatIfNeeded(ctx, chatID, auth); err != nil {
			return err
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(language, "Language saved.", "语言已保存。"), false); err != nil {
			return err
		}
		return c.sendHomeCard(ctx, chatID, userID, localize(language, "Language saved. You can now start from the controls below.", "语言已保存。现在可以通过下面的入口开始使用。"))
	case data == callbackNavNew:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		c.appendAudit(ctx, model.AuditRecord{
			ChatID:    chatID,
			SessionID: c.currentSessionID(ctx),
			EventType: "ui_nav",
			Payload:   map[string]any{"target": "new_session"},
		})
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Creating session.", "正在创建会话。"), false); err != nil {
			return err
		}
		return c.commandNew(ctx, chatID, userID, nil)
	case data == callbackNavSessions:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		c.appendAudit(ctx, model.AuditRecord{
			ChatID:    chatID,
			SessionID: c.currentSessionID(ctx),
			EventType: "ui_nav",
			Payload:   map[string]any{"target": "recent_sessions"},
		})
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Opening recent sessions.", "正在打开最近会话。"), false); err != nil {
			return err
		}
		return c.sendRecentSessionsCard(ctx, chatID, userID)
	case data == callbackNavStatus:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Opening status.", "正在打开状态。"), false); err != nil {
			return err
		}
		return c.sendStatusCard(ctx, chatID, userID)
	case data == callbackNavHelp:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Opening help.", "正在打开帮助。"), false); err != nil {
			return err
		}
		return c.sendHelpCard(ctx, chatID, userID)
	case data == callbackRunStop:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Stopping current run.", "正在停止当前运行。"), false); err != nil {
			return err
		}
		return c.commandStop(ctx, chatID, userID)
	case data == callbackModeShow:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Opening mode picker.", "正在打开模式选择。"), false); err != nil {
			return err
		}
		return c.sendModePicker(ctx, chatID, userID)
	case strings.HasPrefix(data, "mode:set:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		value := strings.TrimPrefix(data, "mode:set:")
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Mode updated.", "模式已更新。"), false); err != nil {
			return err
		}
		return c.commandMode(ctx, chatID, userID, []string{value})
	case data == callbackScopeShow:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Opening scope picker.", "正在打开范围选择。"), false); err != nil {
			return err
		}
		return c.sendScopePicker(ctx, chatID, userID)
	case strings.HasPrefix(data, "scope:set:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		value := strings.TrimPrefix(data, "scope:set:")
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Scope updated.", "范围已更新。"), false); err != nil {
			return err
		}
		return c.commandScope(ctx, chatID, userID, []string{value})
	case data == callbackThinkShow:
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Opening think picker.", "正在打开思考强度选择。"), false); err != nil {
			return err
		}
		return c.sendThinkPicker(ctx, chatID, userID)
	case strings.HasPrefix(data, "think:set:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		value := strings.TrimPrefix(data, "think:set:")
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Think level updated.", "思考强度已更新。"), false); err != nil {
			return err
		}
		return c.commandThink(ctx, chatID, userID, []string{value})
	case strings.HasPrefix(data, "sess:switch:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		sessionID := strings.TrimPrefix(data, "sess:switch:")
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Switching session.", "正在切换会话。"), false); err != nil {
			return err
		}
		return c.switchSession(ctx, chatID, userID, sessionID)
	case strings.HasPrefix(data, "pa:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Received.", "已收到。"), false); err != nil {
			return err
		}
		return c.resolveApproval(ctx, chatID, userID, strings.TrimPrefix(data, "pa:"), true)
	case strings.HasPrefix(data, "pd:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Received.", "已收到。"), false); err != nil {
			return err
		}
		return c.resolveApproval(ctx, chatID, userID, strings.TrimPrefix(data, "pd:"), false)
	case strings.HasPrefix(data, "pc:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
		actionID, optionIndex, ok := parsePlanChoiceCallback(data)
		if !ok {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Invalid plan option.", "无效的规划选项。"), true)
		}
		if err := c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Continuing with that plan.", "将按这个方案继续。"), false); err != nil {
			return err
		}
		return c.resolvePlanChoice(ctx, chatID, userID, actionID, optionIndex)
	case strings.HasPrefix(data, "pr:"):
		if c.requiresVerification() && auth.VerifiedAt == nil {
			return c.tg.AnswerCallback(ctx, callback.ID, localize(auth.PreferredLanguage, "Verification required.", "需要先完成验证。"), true)
		}
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
			now := time.Now().UTC()
			auth.VerifiedAt = &now
			auth.BannedAt = nil
			auth.FailedAttempts = 0
			if err := c.bindOwnerChatIfNeeded(ctx, chatID, auth); err != nil {
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
	if err := c.bindOwnerChatIfNeeded(ctx, chatID, auth); err != nil {
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
		return c.sendHomeCard(ctx, chatID, userID, "")
	case "/help":
		return c.sendHelpCard(ctx, chatID, userID)
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
	c.appendAudit(ctx, model.AuditRecord{
		SessionID: session.SessionID,
		ChatID:    chatID,
		EventType: "ui_nav",
		Payload:   map[string]any{"target": "new_session_created"},
	})
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Created and switched to %s\ncwd: %s\nscope: %s", "已创建并切换到 %s\n目录: %s\n范围: %s", session.SessionID, session.CWD, session.AccessScope), buildHomeKeyboard(c.preferredLanguage(ctx, userID, chatID), &session))
	return err
}

func (c *Coordinator) commandReset(ctx context.Context, chatID, userID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		sendErr := c.sendNoSessionCard(ctx, chatID, userID, "")
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
		sendErr := c.sendNoSessionCard(ctx, chatID, userID, "")
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
		sendErr := c.sendNoSessionCard(ctx, chatID, userID, "")
		if err != nil {
			return err
		}
		return sendErr
	}
	if len(args) == 0 {
		return c.sendModePicker(ctx, chatID, userID)
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
	c.appendAudit(ctx, model.AuditRecord{
		SessionID: session.SessionID,
		ChatID:    chatID,
		EventType: "ui_setting_change",
		Payload: map[string]any{
			"setting": "mode",
			"value":   string(session.Mode),
		},
	})
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Mode updated to %s\nCodex thread reset so the next run uses the new mode.", "模式已更新为 %s\nCodex 线程已重置，下一次运行会使用新模式。", modeLabel(c.preferredLanguage(ctx, userID, chatID), session.Mode)), buildStatusKeyboard(c.preferredLanguage(ctx, userID, chatID), session))
	return err
}

func (c *Coordinator) commandScope(ctx context.Context, chatID, userID string, args []string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		sendErr := c.sendNoSessionCard(ctx, chatID, userID, "")
		if err != nil {
			return err
		}
		return sendErr
	}
	if len(args) == 0 {
		return c.sendScopePicker(ctx, chatID, userID)
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
	c.appendAudit(ctx, model.AuditRecord{
		SessionID: session.SessionID,
		ChatID:    chatID,
		EventType: "ui_setting_change",
		Payload: map[string]any{
			"setting": "scope",
			"value":   string(session.AccessScope),
		},
	})
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Scope updated to %s\nCodex thread reset so the next run uses the new scope.", "范围已更新为 %s\nCodex 线程已重置，下一次运行会使用新范围。", scopeLabel(c.preferredLanguage(ctx, userID, chatID), session.AccessScope)), buildStatusKeyboard(c.preferredLanguage(ctx, userID, chatID), session))
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
	return c.sendStatusCard(ctx, chatID, userID)
}

func (c *Coordinator) commandStop(ctx context.Context, chatID, userID string) error {
	if c.active == nil {
		session, _ := c.store.GetCurrentSession(ctx)
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "No active run.", "当前没有正在运行的任务。"), buildStatusKeyboard(c.preferredLanguage(ctx, userID, chatID), session))
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
	_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Requested cancellation for the current run.", "已经请求取消当前运行。"), buildBusyKeyboard(c.preferredLanguage(ctx, userID, chatID)))
	return err
}

func (c *Coordinator) commandThink(ctx context.Context, chatID, userID string, args []string) error {
	if len(args) == 0 {
		return c.sendThinkPicker(ctx, chatID, userID)
	}
	requested := strings.TrimSpace(args[0])
	if !codex.IsReasoningEffort(requested) {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Usage: /think [minimal|low|medium|high|xhigh]", "用法：/think [minimal|low|medium|high|xhigh]"), nil)
		return err
	}
	if err := codex.WriteReasoningEffort(c.cfg.CodexHome, requested); err != nil {
		return err
	}
	c.appendAudit(ctx, model.AuditRecord{
		SessionID: c.currentSessionID(ctx),
		ChatID:    chatID,
		EventType: "ui_setting_change",
		Payload: map[string]any{
			"setting": "think",
			"value":   requested,
		},
	})
	_, err := c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Updated think level to %s.", "思考强度已更新为 %s。", requested), buildThinkKeyboard(c.preferredLanguage(ctx, userID, chatID), requested))
	return err
}

func (c *Coordinator) handleUserInput(ctx context.Context, chatID, userID string, message *telegram.Message) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil || session == nil {
		sendErr := c.sendNoSessionCard(ctx, chatID, userID, "")
		if err != nil {
			return err
		}
		return sendErr
	}
	if c.active != nil || session.RunState == model.RunRunning || session.RunState == model.RunWaitingApproval || session.RunState == model.RunCancelling {
		return c.sendBusyCard(ctx, chatID, userID, *session)
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
	startedAt := time.Now().UTC()
	previewID, err := c.tg.SendMessage(ctx, chatID, formatRunProgressText(c.preferredLanguage(ctx, userID, chatID), session, localize(c.preferredLanguage(ctx, userID, chatID), "Starting", "启动中"), "", startedAt, startedAt), nil)
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
		StartedAt:        startedAt,
		LastPreviewAt:    startedAt,
		Runner:           run,
		Cleanup:          cleanups,
	}
	heartbeatStop := make(chan struct{})
	active.Cleanup = append(active.Cleanup, func() {
		select {
		case <-heartbeatStop:
		default:
			close(heartbeatStop)
		}
	})
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
	go func(runID string, stop <-chan struct{}) {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.events <- runHeartbeat{RunID: runID}
			}
		}
	}(runID, heartbeatStop)

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
		if err := c.store.SaveSession(ctx, *session); err != nil {
			return err
		}
		return c.updatePreview(ctx, *session, localize(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), "Thread connected", "已连接执行线程"), "")
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
			return c.editPreviewMessage(ctx, c.localizedText(ctx, c.active.UserID, c.active.ChatID, "Plan draft received. Preparing choices...", "已收到规划草案，正在整理选项..."))
		}
		return c.editPreviewMessage(ctx, event.Text)
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
		if err := c.updatePreview(ctx, *session, localize(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), "Waiting for approval", "等待审批"), event.Summary); err != nil {
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
		return c.updatePreview(ctx, *session, localize(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), "Running command", "正在执行命令"), strings.Join(event.Command, " "))
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
		return c.updatePreview(ctx, *session, localize(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), "Applying patch", "正在修改文件"), summarizeChangedPaths(event.ChangedPaths))
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
		return c.finalizeRunMessage(ctx, result.FinalMessage)
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
	return c.finalizeRunMessage(ctx, result.FinalMessage)
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
		return c.finalizeRunMessage(ctx, result.FinalMessage)
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
	if err := c.editPreviewMessage(ctx, formatPlanMessage(language, plan)); err != nil {
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

func (c *Coordinator) appendAudit(ctx context.Context, audit model.AuditRecord) {
	_ = c.store.AppendAudit(ctx, audit)
}

func (c *Coordinator) sendHomeCard(ctx context.Context, chatID, userID, prefix string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil {
		return err
	}
	language := c.preferredLanguage(ctx, userID, chatID)
	text := formatHomeText(language, session)
	if strings.TrimSpace(prefix) != "" {
		text = strings.TrimSpace(prefix) + "\n\n" + text
	}
	_, err = c.tg.SendMessage(ctx, chatID, text, buildHomeKeyboard(language, session))
	return err
}

func (c *Coordinator) sendHelpCard(ctx context.Context, chatID, userID string) error {
	_, err := c.tg.SendMessage(ctx, chatID, c.helpText(ctx, userID, chatID), buildNoSessionKeyboard(c.preferredLanguage(ctx, userID, chatID)))
	return err
}

func (c *Coordinator) sendNoSessionCard(ctx context.Context, chatID, userID, prefix string) error {
	language := c.preferredLanguage(ctx, userID, chatID)
	text := formatNoSessionText(language)
	if strings.TrimSpace(prefix) != "" {
		text = strings.TrimSpace(prefix) + "\n\n" + text
	}
	c.appendAudit(ctx, model.AuditRecord{
		ChatID:    chatID,
		EventType: "ui_recovery",
		Payload:   map[string]any{"reason": "no_session"},
	})
	_, err := c.tg.SendMessage(ctx, chatID, text, buildNoSessionKeyboard(language))
	return err
}

func (c *Coordinator) sendBusyCard(ctx context.Context, chatID, userID string, session model.Session) error {
	c.appendAudit(ctx, model.AuditRecord{
		SessionID: session.SessionID,
		ChatID:    chatID,
		EventType: "ui_recovery",
		Payload:   map[string]any{"reason": "busy"},
	})
	_, err := c.tg.SendMessage(ctx, chatID, formatBusyText(c.preferredLanguage(ctx, userID, chatID), session), buildBusyKeyboard(c.preferredLanguage(ctx, userID, chatID)))
	return err
}

func (c *Coordinator) sendStatusCard(ctx context.Context, chatID, userID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil {
		return err
	}
	if session == nil {
		return c.sendNoSessionCard(ctx, chatID, userID, "")
	}
	_, err = c.tg.SendMessage(ctx, chatID, statusText(c.preferredLanguage(ctx, userID, chatID), *session), buildStatusKeyboard(c.preferredLanguage(ctx, userID, chatID), session))
	return err
}

func (c *Coordinator) sendRecentSessionsCard(ctx context.Context, chatID, userID string) error {
	sessions, err := c.store.ListSessions(ctx)
	if err != nil {
		return err
	}
	if len(sessions) > 5 {
		sessions = sessions[:5]
	}
	currentSessionID := c.currentSessionID(ctx)
	language := c.preferredLanguage(ctx, userID, chatID)
	_, err = c.tg.SendMessage(ctx, chatID, formatRecentSessionsText(language, currentSessionID, sessions), buildRecentSessionsKeyboard(language, currentSessionID, sessions))
	return err
}

func (c *Coordinator) sendModePicker(ctx context.Context, chatID, userID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil {
		return err
	}
	if session == nil {
		return c.sendNoSessionCard(ctx, chatID, userID, "")
	}
	language := c.preferredLanguage(ctx, userID, chatID)
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Choose the mode for session %s.\nCurrent mode: %s", "请选择会话 %s 的模式。\n当前模式：%s", session.SessionID, modeLabel(language, session.Mode)), buildModeKeyboard(language, session.Mode))
	return err
}

func (c *Coordinator) sendScopePicker(ctx context.Context, chatID, userID string) error {
	session, err := c.store.GetCurrentSession(ctx)
	if err != nil {
		return err
	}
	if session == nil {
		return c.sendNoSessionCard(ctx, chatID, userID, "")
	}
	language := c.preferredLanguage(ctx, userID, chatID)
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Choose the scope for session %s.\nCurrent scope: %s", "请选择会话 %s 的范围。\n当前范围：%s", session.SessionID, scopeLabel(language, session.AccessScope)), buildScopeKeyboard(language, session.AccessScope))
	return err
}

func (c *Coordinator) sendThinkPicker(ctx context.Context, chatID, userID string) error {
	current, err := codex.ReadReasoningEffort(c.cfg.CodexHome)
	if err != nil {
		return err
	}
	if current == "" {
		current = "medium"
	}
	language := c.preferredLanguage(ctx, userID, chatID)
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Choose the global think level.\nCurrent level: %s", "请选择全局思考强度。\n当前强度：%s", current), buildThinkKeyboard(language, current))
	return err
}

func (c *Coordinator) switchSession(ctx context.Context, chatID, userID, sessionID string) error {
	session, err := c.store.GetSession(ctx, sessionID)
	if err != nil {
		return err
	}
	if session == nil {
		_, err := c.tg.SendMessage(ctx, chatID, c.localizedText(ctx, userID, chatID, "Session not found.", "未找到该会话。"), buildNoSessionKeyboard(c.preferredLanguage(ctx, userID, chatID)))
		return err
	}
	if err := c.store.SetCurrentSessionID(ctx, sessionID); err != nil {
		return err
	}
	c.appendAudit(ctx, model.AuditRecord{
		SessionID: sessionID,
		ChatID:    chatID,
		EventType: "session_switch",
		Payload:   map[string]any{"session_id": sessionID},
	})
	_, err = c.tg.SendMessage(ctx, chatID, c.localizedTextf(ctx, userID, chatID, "Switched to %s.", "已切换到 %s。", sessionID)+"\n\n"+statusText(c.preferredLanguage(ctx, userID, chatID), *session), buildStatusKeyboard(c.preferredLanguage(ctx, userID, chatID), session))
	return err
}

func (c *Coordinator) updatePreview(ctx context.Context, session model.Session, stage, detail string) error {
	if c.active == nil {
		return nil
	}
	now := time.Now().UTC()
	text := formatRunProgressText(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), session, stage, detail, c.active.StartedAt, now)
	if err := c.editPreviewMessage(ctx, text); err != nil {
		return err
	}
	c.active.LastPreviewAt = now
	return nil
}

func (c *Coordinator) editPreviewMessage(ctx context.Context, text string) error {
	if c.active == nil {
		return nil
	}
	err := c.tg.EditMessageText(ctx, c.active.ChatID, c.active.PreviewMessageID, text)
	if telegram.IsMessageNotModifiedError(err) {
		return nil
	}
	return err
}

func (c *Coordinator) finalizeRunMessage(ctx context.Context, text string) error {
	if err := c.editPreviewMessage(ctx, text); err == nil {
		return nil
	} else {
		_, sendErr := c.tg.SendMessage(ctx, c.active.ChatID, text, nil)
		if sendErr == nil {
			c.logger.Warn("preview edit failed; sent standalone completion message", "err", err, "run_id", c.active.RunID)
			return nil
		}
		return fmt.Errorf("edit preview failed: %w; fallback send failed: %v", err, sendErr)
	}
}

func (c *Coordinator) handleRunHeartbeat(ctx context.Context, runID string) error {
	if c.active == nil || c.active.RunID != runID || c.active.PendingActionID != "" {
		return nil
	}
	if time.Since(c.active.LastPreviewAt) < 15*time.Second {
		return nil
	}
	session, err := c.store.GetSession(ctx, c.active.SessionID)
	if err != nil || session == nil {
		return err
	}
	c.appendAudit(ctx, model.AuditRecord{
		SessionID: session.SessionID,
		ChatID:    c.active.ChatID,
		RunID:     c.active.RunID,
		EventType: "run_heartbeat",
		Payload: map[string]any{
			"elapsed_seconds": int(time.Since(c.active.StartedAt).Seconds()),
		},
	})
	return c.updatePreview(ctx, *session, localize(c.preferredLanguage(ctx, c.active.UserID, c.active.ChatID), "Still working", "仍在处理中"), "")
}

func summarizeChangedPaths(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	if len(paths) <= 3 {
		return strings.Join(paths, ", ")
	}
	return strings.Join(paths[:3], ", ") + fmt.Sprintf(" +%d", len(paths)-3)
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
	auth, err := c.store.GetTelegramUserAuth(ctx, userID)
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

func (c *Coordinator) runMaintenance(ctx context.Context, now time.Time) error {
	if _, err := c.authorizedChatID(ctx); err != nil {
		return err
	}
	resolvedRetentionDays := c.cfg.ResolvedApprovalRetentionDays
	if resolvedRetentionDays <= 0 {
		resolvedRetentionDays = 7
	}
	expiredRetentionDays := c.cfg.ExpiredApprovalRetentionDays
	if expiredRetentionDays <= 0 {
		expiredRetentionDays = 1
	}
	maxAuditRows := c.cfg.MaxAuditRows
	if maxAuditRows <= 0 {
		maxAuditRows = 1000
	}
	maxSessionRows := c.cfg.MaxSessionRows
	if maxSessionRows <= 0 {
		maxSessionRows = 100
	}
	if err := c.store.Cleanup(ctx, now.AddDate(0, 0, -resolvedRetentionDays), now.AddDate(0, 0, -expiredRetentionDays), maxAuditRows); err != nil {
		return err
	}
	currentSessionID, err := c.store.GetCurrentSessionID(ctx)
	if err != nil {
		return err
	}
	if err := c.store.PruneSessions(ctx, currentSessionID, maxSessionRows); err != nil {
		return err
	}
	if err := cleanupBridgeRuntimeFiles(c.cfg, now); err != nil {
		return err
	}
	if err := cleanupCodexArtifacts(c.cfg.CodexHome, now); err != nil {
		return err
	}

	vacuumHours := c.cfg.DBVacuumIntervalHours
	if vacuumHours <= 0 {
		vacuumHours = 24
	}
	if c.lastVacuumAt.IsZero() || now.Sub(c.lastVacuumAt) >= time.Duration(vacuumHours)*time.Hour {
		if err := c.store.Vacuum(ctx); err != nil {
			return err
		}
		c.lastVacuumAt = now
	}
	if c.lastCodexDBAt.IsZero() || now.Sub(c.lastCodexDBAt) >= 24*time.Hour {
		if err := checkpointCodexStateDBs(c.cfg.CodexHome); err != nil {
			return err
		}
		c.lastCodexDBAt = now
	}
	return nil
}

func (c *Coordinator) ensureAuthorizedChat(ctx context.Context, chatID string) (bool, error) {
	authorizedChatID, err := c.authorizedChatID(ctx)
	if err != nil {
		return false, err
	}
	if authorizedChatID == "" || authorizedChatID == chatID {
		return true, nil
	}
	_, _ = c.tg.SendMessage(ctx, chatID, "This chat is not authorized for the bridge.", nil)
	return false, nil
}

func (c *Coordinator) authorizedChatID(ctx context.Context) (string, error) {
	if strings.TrimSpace(c.cfg.OwnerChatID) != "" {
		return strings.TrimSpace(c.cfg.OwnerChatID), nil
	}
	stored, err := c.store.GetOwnerChatID(ctx)
	if err != nil || stored != "" {
		return stored, err
	}
	auth, err := c.store.GetTelegramUserAuth(ctx, c.cfg.OwnerUserID)
	if err != nil || auth == nil || strings.TrimSpace(auth.LatestChatID) == "" {
		return "", err
	}
	if c.requiresVerification() && auth.VerifiedAt == nil {
		return "", nil
	}
	if err := c.store.SetOwnerChatID(ctx, auth.LatestChatID); err != nil {
		return "", err
	}
	return auth.LatestChatID, nil
}

func (c *Coordinator) bindOwnerChatIfNeeded(ctx context.Context, chatID string, auth *model.TelegramUserAuth) error {
	if strings.TrimSpace(c.cfg.OwnerChatID) != "" {
		return nil
	}
	if c.requiresVerification() && (auth == nil || auth.VerifiedAt == nil) {
		return nil
	}
	current, err := c.store.GetOwnerChatID(ctx)
	if err != nil {
		return err
	}
	if current == "" {
		return c.store.SetOwnerChatID(ctx, chatID)
	}
	return nil
}
