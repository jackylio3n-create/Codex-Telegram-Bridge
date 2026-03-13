package codex

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var supportedReasoningEfforts = map[string]struct{}{
	"minimal": {},
	"low":     {},
	"medium":  {},
	"high":    {},
	"xhigh":   {},
}

func IsReasoningEffort(value string) bool {
	_, ok := supportedReasoningEfforts[strings.TrimSpace(value)]
	return ok
}

func ReadReasoningEffort(codexHome string) (string, error) {
	return readConfigString(codexHome, "model_reasoning_effort")
}

func ReadPlanReasoningEffort(codexHome string) (string, error) {
	return readConfigString(codexHome, "plan_mode_reasoning_effort")
}

func readConfigString(codexHome, key string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	match := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*"([^"]*)"`).FindSubmatch(raw)
	if len(match) != 2 {
		return "", nil
	}
	return string(match[1]), nil
}

func WriteReasoningEffort(codexHome, effort string) error {
	if !IsReasoningEffort(effort) {
		return fmt.Errorf("unsupported reasoning effort: %s", effort)
	}
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return err
	}

	configPath := filepath.Join(codexHome, "config.toml")
	current, err := os.ReadFile(configPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	nextLine := fmt.Sprintf(`model_reasoning_effort = "%s"`, effort)
	currentText := strings.TrimRight(string(current), "\n")
	re := regexp.MustCompile(`(?m)^\s*model_reasoning_effort\s*=.*$`)
	var next string
	if re.MatchString(currentText) {
		next = re.ReplaceAllString(currentText, nextLine)
	} else if strings.TrimSpace(currentText) == "" {
		next = nextLine
	} else {
		next = currentText + "\n" + nextLine
	}

	return os.WriteFile(configPath, []byte(next+"\n"), 0o600)
}
