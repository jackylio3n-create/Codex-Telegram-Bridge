package app

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"codextelegrambridge/internal/model"
	"codextelegrambridge/internal/telegram"
)

const (
	callbackNavNew      = "nav:new"
	callbackNavSessions = "nav:sessions"
	callbackNavStatus   = "nav:status"
	callbackNavHelp     = "nav:help"
	callbackRunStop     = "run:stop"
	callbackModeShow    = "mode:show"
	callbackScopeShow   = "scope:show"
	callbackThinkShow   = "think:show"
)

func formatHomeText(language string, session *model.Session) string {
	if session == nil {
		return localize(language,
			"Codex Telegram Bridge is ready.\nNo session is selected yet.\nCreate one to start chatting from Telegram.",
			"Codex Telegram Bridge 已就绪。\n当前还没有选中的会话。\n先创建一个会话再开始聊天。",
		)
	}

	lines := []string{
		localize(language, "Current session:", "当前会话："),
		fmt.Sprintf("%s: %s", localize(language, "Session", "会话"), session.SessionID),
		fmt.Sprintf("%s: %s", localize(language, "Directory", "目录"), session.CWD),
		fmt.Sprintf("%s: %s", localize(language, "Mode", "模式"), modeLabel(language, session.Mode)),
		fmt.Sprintf("%s: %s", localize(language, "Scope", "范围"), scopeLabel(language, session.AccessScope)),
		fmt.Sprintf("%s: %s", localize(language, "State", "状态"), runStateLabel(language, session.RunState)),
	}
	if strings.TrimSpace(session.LastError) != "" && session.RunState == model.RunFailed {
		lines = append(lines, fmt.Sprintf("%s: %s", localize(language, "Last error", "最近错误"), session.LastError))
	}
	return strings.Join(lines, "\n")
}

func formatNoSessionText(language string) string {
	return localize(language,
		"No session is selected.\nCreate a new one or switch to a recent session.",
		"当前没有选中的会话。\n请创建新会话，或切换到最近使用的会话。",
	)
}

func formatBusyText(language string, session model.Session) string {
	return fmt.Sprintf("%s\n%s: %s\n%s: %s",
		localize(language, "This session is busy right now.", "当前会话正在忙碌中。"),
		localize(language, "Session", "会话"), session.SessionID,
		localize(language, "State", "状态"), runStateLabel(language, session.RunState),
	)
}

func formatRecentSessionsText(language, currentSessionID string, sessions []model.Session) string {
	lines := []string{localize(language, "Recent sessions:", "最近会话：")}
	if len(sessions) == 0 {
		lines = append(lines, localize(language, "No saved sessions yet.", "还没有保存的会话。"))
		return strings.Join(lines, "\n")
	}
	for index, session := range sessions {
		label := fmt.Sprintf("%d. %s", index+1, session.SessionID)
		if session.SessionID == currentSessionID {
			label += " " + localize(language, "[current]", "[当前]")
		}
		lines = append(lines, label)
		lines = append(lines, fmt.Sprintf("   %s | %s | %s", sessionPathLabel(session.CWD), modeLabel(language, session.Mode), runStateLabel(language, session.RunState)))
	}
	return strings.Join(lines, "\n")
}

func formatRunProgressText(language string, session model.Session, stage, detail string, startedAt, now time.Time) string {
	lines := []string{
		localize(language, "Codex is running", "Codex 正在运行"),
		fmt.Sprintf("%s: %s", localize(language, "Directory", "目录"), session.CWD),
		fmt.Sprintf("%s: %s", localize(language, "Mode", "模式"), modeLabel(language, session.Mode)),
		fmt.Sprintf("%s: %s", localize(language, "Scope", "范围"), scopeLabel(language, session.AccessScope)),
		fmt.Sprintf("%s: %s", localize(language, "Stage", "阶段"), stage),
	}
	if strings.TrimSpace(detail) != "" {
		lines = append(lines, fmt.Sprintf("%s: %s", localize(language, "Detail", "详情"), detail))
	}
	if !startedAt.IsZero() {
		lines = append(lines, fmt.Sprintf("%s: %s", localize(language, "Elapsed", "已耗时"), formatElapsed(now.Sub(startedAt))))
	}
	return strings.Join(lines, "\n")
}

func buildHomeKeyboard(language string, session *model.Session) *telegram.InlineKeyboardMarkup {
	if session == nil {
		return &telegram.InlineKeyboardMarkup{
			InlineKeyboard: [][]telegram.InlineKeyboardButton{
				{
					button(localize(language, "New Session", "新建会话"), callbackNavNew),
					button(localize(language, "Recent Sessions", "最近会话"), callbackNavSessions),
				},
				{
					button(localize(language, "Help", "帮助"), callbackNavHelp),
				},
			},
		}
	}

	rows := [][]telegram.InlineKeyboardButton{
		{
			button(localize(language, "Status", "状态"), callbackNavStatus),
			button(localize(language, "Recent Sessions", "最近会话"), callbackNavSessions),
		},
		{
			button(localize(language, "Mode", "模式"), callbackModeShow),
			button(localize(language, "Scope", "范围"), callbackScopeShow),
		},
		{
			button(localize(language, "Think", "思考强度"), callbackThinkShow),
			button(localize(language, "Help", "帮助"), callbackNavHelp),
		},
	}
	if session.RunState == model.RunRunning || session.RunState == model.RunWaitingApproval || session.RunState == model.RunCancelling {
		rows = append([][]telegram.InlineKeyboardButton{{
			button(localize(language, "Stop", "停止"), callbackRunStop),
			button(localize(language, "Status", "状态"), callbackNavStatus),
		}}, rows...)
	}
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func buildNoSessionKeyboard(language string) *telegram.InlineKeyboardMarkup {
	return &telegram.InlineKeyboardMarkup{
		InlineKeyboard: [][]telegram.InlineKeyboardButton{
			{
				button(localize(language, "New Session", "新建会话"), callbackNavNew),
				button(localize(language, "Recent Sessions", "最近会话"), callbackNavSessions),
			},
			{
				button(localize(language, "Help", "帮助"), callbackNavHelp),
			},
		},
	}
}

func buildBusyKeyboard(language string) *telegram.InlineKeyboardMarkup {
	return &telegram.InlineKeyboardMarkup{
		InlineKeyboard: [][]telegram.InlineKeyboardButton{
			{
				button(localize(language, "Status", "状态"), callbackNavStatus),
				button(localize(language, "Stop", "停止"), callbackRunStop),
			},
			{
				button(localize(language, "Recent Sessions", "最近会话"), callbackNavSessions),
			},
		},
	}
}

func buildStatusKeyboard(language string, session *model.Session) *telegram.InlineKeyboardMarkup {
	if session == nil {
		return buildNoSessionKeyboard(language)
	}
	rows := [][]telegram.InlineKeyboardButton{
		{
			button(localize(language, "Recent Sessions", "最近会话"), callbackNavSessions),
			button(localize(language, "Help", "帮助"), callbackNavHelp),
		},
		{
			button(localize(language, "Mode", "模式"), callbackModeShow),
			button(localize(language, "Scope", "范围"), callbackScopeShow),
		},
	}
	if session.RunState == model.RunRunning || session.RunState == model.RunWaitingApproval || session.RunState == model.RunCancelling {
		rows = append([][]telegram.InlineKeyboardButton{{
			button(localize(language, "Stop", "停止"), callbackRunStop),
		}}, rows...)
	}
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func buildRecentSessionsKeyboard(language, currentSessionID string, sessions []model.Session) *telegram.InlineKeyboardMarkup {
	rows := make([][]telegram.InlineKeyboardButton, 0, len(sessions)+2)
	for _, session := range sessions {
		rows = append(rows, []telegram.InlineKeyboardButton{{
			Text:         sessionButtonLabel(language, session, session.SessionID == currentSessionID),
			CallbackData: "sess:switch:" + session.SessionID,
		}})
	}
	rows = append(rows, []telegram.InlineKeyboardButton{{
		Text:         localize(language, "New Session", "新建会话"),
		CallbackData: callbackNavNew,
	}})
	rows = append(rows, []telegram.InlineKeyboardButton{{
		Text:         localize(language, "Help", "帮助"),
		CallbackData: callbackNavHelp,
	}})
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func buildModeKeyboard(language string, current model.SessionMode) *telegram.InlineKeyboardMarkup {
	rows := make([][]telegram.InlineKeyboardButton, 0, 4)
	for _, mode := range []model.SessionMode{model.ModeAsk, model.ModePlan, model.ModeCode} {
		label := modeLabel(language, mode)
		if mode == current {
			label += " " + localize(language, "[current]", "[当前]")
		}
		rows = append(rows, []telegram.InlineKeyboardButton{{
			Text:         label,
			CallbackData: "mode:set:" + string(mode),
		}})
	}
	rows = append(rows, []telegram.InlineKeyboardButton{{
		Text:         localize(language, "Status", "状态"),
		CallbackData: callbackNavStatus,
	}})
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func buildScopeKeyboard(language string, current model.SessionAccessScope) *telegram.InlineKeyboardMarkup {
	rows := make([][]telegram.InlineKeyboardButton, 0, 3)
	for _, scope := range []model.SessionAccessScope{model.ScopeWorkspace, model.ScopeSystem} {
		label := scopeLabel(language, scope)
		if scope == current {
			label += " " + localize(language, "[current]", "[当前]")
		}
		rows = append(rows, []telegram.InlineKeyboardButton{{
			Text:         label,
			CallbackData: "scope:set:" + string(scope),
		}})
	}
	rows = append(rows, []telegram.InlineKeyboardButton{{
		Text:         localize(language, "Status", "状态"),
		CallbackData: callbackNavStatus,
	}})
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func buildThinkKeyboard(language, current string) *telegram.InlineKeyboardMarkup {
	rows := make([][]telegram.InlineKeyboardButton, 0, 6)
	for _, level := range []string{"minimal", "low", "medium", "high", "xhigh"} {
		label := level
		if level == current {
			label += " " + localize(language, "[current]", "[当前]")
		}
		rows = append(rows, []telegram.InlineKeyboardButton{{
			Text:         label,
			CallbackData: "think:set:" + level,
		}})
	}
	rows = append(rows, []telegram.InlineKeyboardButton{{
		Text:         localize(language, "Status", "状态"),
		CallbackData: callbackNavStatus,
	}})
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func sessionPathLabel(path string) string {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || path == "" || path == string(filepath.Separator) {
		return path
	}
	return filepath.Base(path)
}

func sessionButtonLabel(language string, session model.Session, current bool) string {
	label := fmt.Sprintf("%s [%s]", sessionPathLabel(session.CWD), modeLabel(language, session.Mode))
	if current {
		return localize(language, "当前 · ", "当前 · ") + label
	}
	return label
}

func formatElapsed(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Round(time.Second).Seconds()))
	}
	minutes := int(d / time.Minute)
	seconds := int((d % time.Minute) / time.Second)
	return fmt.Sprintf("%dm%02ds", minutes, seconds)
}

func button(text, data string) telegram.InlineKeyboardButton {
	return telegram.InlineKeyboardButton{
		Text:         text,
		CallbackData: data,
	}
}
