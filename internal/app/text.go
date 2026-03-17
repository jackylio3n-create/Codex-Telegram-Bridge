package app

import (
	"fmt"
	"strings"

	"codextelegrambridge/internal/model"
)

func normalizeLanguage(language string) string {
	if strings.EqualFold(strings.TrimSpace(language), "zh") {
		return "zh"
	}
	return "en"
}

func localize(language, english, chinese string) string {
	if normalizeLanguage(language) == "zh" {
		return chinese
	}
	return english
}

func commandHelpText(language string) string {
	if normalizeLanguage(language) == "zh" {
		return strings.Join([]string{
			"开始使用：",
			"/start - 显示首页和快捷入口",
			"/help - 显示这份帮助",
			"/new [cwd] - 创建并切换到新会话",
			"",
			"日常控制：",
			"/cd <path> - 修改当前工作目录",
			"/mode <ask|plan|code> - 切换模式",
			"/scope [workspace|system] - 切换访问范围",
			"/think [minimal|low|medium|high|xhigh] - 设置思考强度",
			"/stat - 查看当前 bridge 会话状态",
			"/ctx - 查看当前 Codex 运行上下文",
			"",
			"故障恢复：",
			"/reset - 重置当前会话上下文",
			"/stop - 停止当前运行",
		}, "\n")
	}
	return strings.Join([]string{
		"Getting started:",
		"/start - show the home card and quick actions",
		"/help - show this help text",
		"/new [cwd] - create and switch to a new session",
		"",
		"Daily control:",
		"/cd <path> - change the current working directory",
		"/mode <ask|plan|code> - change the current mode",
		"/scope [workspace|system] - change access scope",
		"/think [minimal|low|medium|high|xhigh] - set reasoning effort",
		"/stat - show current bridge session state",
		"/ctx - show current Codex runtime context",
		"",
		"Recovery:",
		"/reset - reset the current session context",
		"/stop - stop the active run",
	}, "\n")
}

func modeLabel(language string, mode model.SessionMode) string {
	if normalizeLanguage(language) == "zh" {
		switch mode {
		case model.ModeAsk:
			return "提问"
		case model.ModePlan:
			return "规划"
		case model.ModeCode:
			return "编码"
		}
	}
	return string(mode)
}

func scopeLabel(language string, scope model.SessionAccessScope) string {
	if normalizeLanguage(language) == "zh" {
		switch scope {
		case model.ScopeWorkspace:
			return "工作区"
		case model.ScopeSystem:
			return "系统"
		}
	}
	return string(scope)
}

func statusText(language string, session model.Session) string {
	if normalizeLanguage(language) == "zh" {
		text := fmt.Sprintf("会话: %s\n目录: %s\n模式: %s\n范围: %s\n运行状态: %s\n线程: %s", session.SessionID, session.CWD, modeLabel(language, session.Mode), scopeLabel(language, session.AccessScope), runStateLabel(language, session.RunState), emptyFallback(session.CodexThreadID, "-"))
		if strings.TrimSpace(session.LastError) != "" {
			text += fmt.Sprintf("\n最近错误: %s", session.LastError)
		}
		return text
	}
	text := fmt.Sprintf("session: %s\ncwd: %s\nmode: %s\nscope: %s\nrun_state: %s\nthread: %s", session.SessionID, session.CWD, modeLabel(language, session.Mode), scopeLabel(language, session.AccessScope), session.RunState, emptyFallback(session.CodexThreadID, "-"))
	if strings.TrimSpace(session.LastError) != "" {
		text += fmt.Sprintf("\nlast_error: %s", session.LastError)
	}
	return text
}

func runStateLabel(language string, state model.SessionRunState) string {
	if normalizeLanguage(language) == "zh" {
		switch state {
		case model.RunIdle:
			return "空闲"
		case model.RunRunning:
			return "运行中"
		case model.RunWaitingApproval:
			return "等待审批"
		case model.RunCancelling:
			return "正在取消"
		case model.RunCancelled:
			return "已取消"
		case model.RunFailed:
			return "失败"
		}
	}
	return string(state)
}
