package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type PlanOption struct {
	Title       string `json:"title"`
	Details     string `json:"details"`
	Recommended bool   `json:"recommended"`
}

type PlanResponse struct {
	Summary     string       `json:"summary"`
	Assumptions []string     `json:"assumptions"`
	Options     []PlanOption `json:"options"`
}

const planSchemaJSON = `{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "assumptions", "options"],
  "properties": {
    "summary": {"type": "string"},
    "assumptions": {
      "type": "array",
      "items": {"type": "string"}
    },
    "options": {
      "type": "array",
      "minItems": 1,
      "maxItems": 4,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "details", "recommended"],
        "properties": {
          "title": {"type": "string"},
          "details": {"type": "string"},
          "recommended": {"type": "boolean"}
        }
      }
    }
  }
}
`

func BuildPlanPrompt(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	return strings.TrimSpace(`You are operating in plan mode.

Return only a JSON object that matches the provided output schema.
Do not edit files.
Do not apply patches.
Do not run shell commands.
Give a concrete implementation plan with clear tradeoffs.
When there is more than one sensible path, provide 2-4 options and mark exactly one as recommended.
Keep the response concise but specific enough that the selected option can be executed next.

User request:
` + prompt)
}

func WritePlanSchema(tempDir string) (string, func(), error) {
	if err := os.MkdirAll(tempDir, 0o700); err != nil {
		return "", nil, err
	}
	path := filepath.Join(tempDir, fmt.Sprintf("plan-schema-%d-%d.json", os.Getpid(), time.Now().UnixNano()))
	if err := os.WriteFile(path, []byte(planSchemaJSON), 0o600); err != nil {
		return "", nil, err
	}
	return path, func() { _ = os.Remove(path) }, nil
}

func ParsePlanResponse(text string) (PlanResponse, error) {
	var plan PlanResponse
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &plan); err != nil {
		return PlanResponse{}, err
	}
	plan.Summary = strings.TrimSpace(plan.Summary)
	if plan.Summary == "" {
		return PlanResponse{}, fmt.Errorf("plan summary is required")
	}
	if len(plan.Options) == 0 {
		return PlanResponse{}, fmt.Errorf("at least one plan option is required")
	}
	recommendedCount := 0
	for index := range plan.Options {
		plan.Options[index].Title = strings.TrimSpace(plan.Options[index].Title)
		plan.Options[index].Details = strings.TrimSpace(plan.Options[index].Details)
		if plan.Options[index].Title == "" || plan.Options[index].Details == "" {
			return PlanResponse{}, fmt.Errorf("plan option %d is incomplete", index+1)
		}
		if plan.Options[index].Recommended {
			recommendedCount++
		}
	}
	if recommendedCount != 1 {
		return PlanResponse{}, fmt.Errorf("expected exactly one recommended plan option")
	}
	for index, assumption := range plan.Assumptions {
		plan.Assumptions[index] = strings.TrimSpace(assumption)
	}
	return plan, nil
}

func MarshalPlanResponse(plan PlanResponse) string {
	body, _ := json.Marshal(plan)
	return string(body)
}

func BuildPlanExecutionPrompt(originalPrompt string, plan PlanResponse, optionIndex int) string {
	selected := plan.Options[optionIndex]
	assumptions := strings.Join(plan.Assumptions, "\n- ")
	if assumptions != "" {
		assumptions = "- " + assumptions
	}
	return strings.TrimSpace(fmt.Sprintf(`The user selected an implementation option from plan mode. Execute it now.

Original user request:
%s

Approved plan summary:
%s

Selected option:
%s
%s

Assumptions:
%s

Carry out the selected option. Make the required changes, run the necessary commands, and report the result.`, strings.TrimSpace(originalPrompt), plan.Summary, selected.Title, selected.Details, assumptions))
}

func BuildPlanRetryPrompt(originalPrompt string, plan PlanResponse) string {
	return strings.TrimSpace(fmt.Sprintf(`The user rejected the previous plan options. Produce a different plan.

Original user request:
%s

Rejected plan summary:
%s`, strings.TrimSpace(originalPrompt), plan.Summary))
}
