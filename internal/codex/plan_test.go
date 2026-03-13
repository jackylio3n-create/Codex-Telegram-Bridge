package codex

import "testing"

func TestParsePlanResponse(t *testing.T) {
	t.Parallel()

	plan, err := ParsePlanResponse(`{
		"summary":"Ship the fix safely",
		"assumptions":["tests exist"],
		"options":[
			{"title":"Minimal patch","details":"Change the failing branch and run targeted tests","recommended":true},
			{"title":"Broader cleanup","details":"Refactor the module before fixing the bug","recommended":false}
		]
	}`)
	if err != nil {
		t.Fatalf("parse plan: %v", err)
	}
	if plan.Summary != "Ship the fix safely" {
		t.Fatalf("unexpected summary: %q", plan.Summary)
	}
	if len(plan.Options) != 2 {
		t.Fatalf("unexpected option count: %d", len(plan.Options))
	}
	if !plan.Options[0].Recommended {
		t.Fatalf("expected first option to be recommended")
	}
}
