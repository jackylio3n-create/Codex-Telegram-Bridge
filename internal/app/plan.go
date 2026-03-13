package app

import (
	"fmt"
	"strconv"
	"strings"

	"codextelegrambridge/internal/codex"
	"codextelegrambridge/internal/model"
	"codextelegrambridge/internal/telegram"
)

func formatPlanMessage(language string, plan codex.PlanResponse) string {
	lines := []string{localize(language, "Plan ready:", "规划已生成："), plan.Summary}
	if len(plan.Assumptions) > 0 {
		lines = append(lines, "")
		lines = append(lines, localize(language, "Assumptions:", "前提假设："))
		for _, item := range plan.Assumptions {
			item = strings.TrimSpace(item)
			if item != "" {
				lines = append(lines, "- "+item)
			}
		}
	}
	lines = append(lines, "", localize(language, "Options:", "可选方案："))
	for index, option := range plan.Options {
		prefix := fmt.Sprintf("%d. ", index+1)
		if option.Recommended {
			prefix = prefix + localize(language, "[Recommended] ", "[推荐] ")
		}
		lines = append(lines, prefix+option.Title)
		lines = append(lines, option.Details)
	}
	return strings.Join(lines, "\n")
}

func buildPlanChoiceKeyboard(language, actionID string, plan codex.PlanResponse) *telegram.InlineKeyboardMarkup {
	rows := make([][]telegram.InlineKeyboardButton, 0, len(plan.Options)+1)
	for index, option := range plan.Options {
		label := fmt.Sprintf("%d", index+1)
		if option.Recommended {
			label = localize(language, "Use Recommended", "采用推荐方案")
		} else {
			label = localize(language, "Use Option ", "采用方案 ") + label
		}
		rows = append(rows, []telegram.InlineKeyboardButton{{
			Text:         label,
			CallbackData: fmt.Sprintf("pc:%s:%d", actionID, index),
		}})
	}
	rows = append(rows, []telegram.InlineKeyboardButton{{
		Text:         localize(language, "Rethink Plan", "重新规划"),
		CallbackData: "pr:" + actionID,
	}})
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func parsePlanChoiceCallback(data string) (string, int, bool) {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(data), "pc:"), ":")
	if len(parts) != 2 {
		return "", 0, false
	}
	index, err := strconv.Atoi(parts[1])
	if err != nil || index < 0 {
		return "", 0, false
	}
	return parts[0], index, true
}

func recommendedPlanOptionIndex(plan codex.PlanResponse) int {
	for index, option := range plan.Options {
		if option.Recommended {
			return index
		}
	}
	return 0
}

func pendingActionSummary(language string, action model.PendingAction) string {
	switch model.PendingActionType(action.ActionType) {
	case model.ActionPlanChoice:
		return localize(language, "Pending plan choices:", "待处理规划选择：")
	default:
		return localize(language, "Pending approvals:", "待审批请求：")
	}
}
