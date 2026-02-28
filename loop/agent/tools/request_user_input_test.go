package tools

import (
	"context"
	"encoding/json"
	"testing"
)

func TestRequestUserInputValidatesAndReturnsPayload(t *testing.T) {
	args := json.RawMessage(`{
		"questions": [
			{
				"id": "choice",
				"header": "Decision",
				"question": "Which option should we choose?",
				"options": [
					{"label": "A (Recommended)", "description": "Fastest path."},
					{"label": "B", "description": "More setup but flexible."}
				]
			}
		]
	}`)

	out, err := handleRequestUserInput(context.Background(), args)
	if err != nil {
		t.Fatalf("handleRequestUserInput failed: %v", err)
	}

	var resp map[string]any
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["supported"] != false {
		t.Fatalf("expected supported=false, got %#v", resp["supported"])
	}
	if _, ok := resp["questions"]; !ok {
		t.Fatal("expected normalized questions in response")
	}
}

func TestRequestUserInputRejectsInvalidOptionCount(t *testing.T) {
	args := json.RawMessage(`{
		"questions": [
			{
				"id": "choice",
				"header": "Decision",
				"question": "Pick one",
				"options": [{"label": "A", "description": "Only option"}]
			}
		]
	}`)

	_, err := handleRequestUserInput(context.Background(), args)
	if err == nil {
		t.Fatal("expected error for option count < 2")
	}
}

func TestRequestUserInputRejectsDuplicateIDs(t *testing.T) {
	args := json.RawMessage(`{
		"questions": [
			{
				"id": "same",
				"header": "One",
				"question": "Q1",
				"options": [
					{"label": "A", "description": "desc"},
					{"label": "B", "description": "desc"}
				]
			},
			{
				"id": "same",
				"header": "Two",
				"question": "Q2",
				"options": [
					{"label": "A", "description": "desc"},
					{"label": "B", "description": "desc"}
				]
			}
		]
	}`)

	_, err := handleRequestUserInput(context.Background(), args)
	if err == nil {
		t.Fatal("expected error for duplicate question IDs")
	}
}
