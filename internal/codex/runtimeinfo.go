package codex

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

type RuntimeInfo struct {
	Model                  string
	ReasoningEffort        string
	ContextWindow          int
	TotalTokens            int
	ContextRemaining       int
	PrimaryUsedPercent     float64
	PrimaryWindowMinutes   int
	PrimaryResetsAt        time.Time
	SecondaryUsedPercent   float64
	SecondaryWindowMinutes int
	SecondaryResetsAt      time.Time
}

func ReadRuntimeInfo(codexHome string) (RuntimeInfo, error) {
	info := RuntimeInfo{}
	if model, err := readConfigString(codexHome, "model"); err == nil {
		info.Model = model
	}
	if effort, err := ReadReasoningEffort(codexHome); err == nil {
		info.ReasoningEffort = effort
	}

	path, err := latestSessionFile(codexHome)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return info, nil
		}
		return info, err
	}
	file, err := os.Open(path)
	if err != nil {
		return info, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buffer := make([]byte, 0, 64*1024)
	scanner.Buffer(buffer, 2*1024*1024)
	for scanner.Scan() {
		var envelope struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &envelope); err != nil {
			continue
		}
		switch envelope.Type {
		case "turn_context":
			var payload struct {
				Model  string `json:"model"`
				Effort string `json:"effort"`
			}
			if json.Unmarshal(envelope.Payload, &payload) == nil {
				if payload.Model != "" {
					info.Model = payload.Model
				}
				if payload.Effort != "" {
					info.ReasoningEffort = payload.Effort
				}
			}
		case "event_msg":
			var payload struct {
				Type string `json:"type"`
				Info struct {
					TotalTokenUsage struct {
						TotalTokens int `json:"total_tokens"`
					} `json:"total_token_usage"`
					ModelContextWindow int `json:"model_context_window"`
				} `json:"info"`
				RateLimits struct {
					Primary struct {
						UsedPercent   float64 `json:"used_percent"`
						WindowMinutes int     `json:"window_minutes"`
						ResetsAt      int64   `json:"resets_at"`
					} `json:"primary"`
					Secondary struct {
						UsedPercent   float64 `json:"used_percent"`
						WindowMinutes int     `json:"window_minutes"`
						ResetsAt      int64   `json:"resets_at"`
					} `json:"secondary"`
				} `json:"rate_limits"`
			}
			if json.Unmarshal(envelope.Payload, &payload) == nil && payload.Type == "token_count" {
				info.TotalTokens = payload.Info.TotalTokenUsage.TotalTokens
				info.ContextWindow = payload.Info.ModelContextWindow
				if info.ContextWindow > 0 {
					info.ContextRemaining = info.ContextWindow - info.TotalTokens
					if info.ContextRemaining < 0 {
						info.ContextRemaining = 0
					}
				}
				info.PrimaryUsedPercent = payload.RateLimits.Primary.UsedPercent
				info.PrimaryWindowMinutes = payload.RateLimits.Primary.WindowMinutes
				info.PrimaryResetsAt = unixOrZero(payload.RateLimits.Primary.ResetsAt)
				info.SecondaryUsedPercent = payload.RateLimits.Secondary.UsedPercent
				info.SecondaryWindowMinutes = payload.RateLimits.Secondary.WindowMinutes
				info.SecondaryResetsAt = unixOrZero(payload.RateLimits.Secondary.ResetsAt)
			}
		}
	}
	return info, scanner.Err()
}

func latestSessionFile(codexHome string) (string, error) {
	root := filepath.Join(codexHome, "sessions")
	var latestPath string
	var latestTime time.Time
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		if latestPath == "" || info.ModTime().After(latestTime) {
			latestPath = path
			latestTime = info.ModTime()
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if latestPath == "" {
		return "", os.ErrNotExist
	}
	return latestPath, nil
}

func unixOrZero(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.Unix(value, 0).UTC()
}

func FormatWindowRemaining(usedPercent float64) string {
	if usedPercent <= 0 {
		return "100.0%"
	}
	remaining := 100.0 - usedPercent
	if remaining < 0 {
		remaining = 0
	}
	return fmt.Sprintf("%.1f%%", remaining)
}
