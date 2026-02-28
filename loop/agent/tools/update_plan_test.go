package tools

import (
	"context"
	"encoding/json"
	"testing"
)

func TestUpdatePlanValidPayload(t *testing.T) {
	args := json.RawMessage(`{"explanation":"initial plan","plan":[{"step":"Inspect code","status":"completed"},{"step":"Patch file","status":"in_progress"}]}`)

	out, err := handleUpdatePlan(context.Background(), args)
	if err != nil {
		t.Fatalf("handleUpdatePlan failed: %v", err)
	}

	var resp map[string]any
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["output"] != "Plan updated" {
		t.Fatalf("unexpected output: %#v", resp["output"])
	}
	if resp["in_progress_count"].(float64) != 1 {
		t.Fatalf("expected in_progress_count=1, got %#v", resp["in_progress_count"])
	}
}

func TestUpdatePlanRejectsMultipleInProgress(t *testing.T) {
	args := json.RawMessage(`{"plan":[{"step":"A","status":"in_progress"},{"step":"B","status":"in_progress"}]}`)

	_, err := handleUpdatePlan(context.Background(), args)
	if err == nil {
		t.Fatal("expected error for multiple in_progress steps")
	}
}

func TestUpdatePlanRejectsInvalidStatus(t *testing.T) {
	args := json.RawMessage(`{"plan":[{"step":"A","status":"done"}]}`)

	_, err := handleUpdatePlan(context.Background(), args)
	if err == nil {
		t.Fatal("expected error for invalid status")
	}
}
