package tools

import (
	"context"
	"encoding/json"
	"strings"
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

func TestRequestUserInputTruncatesLongHeader(t *testing.T) {
	args := json.RawMessage(`{
		"questions": [
			{
				"id": "approval_decision",
				"header": "This header is much too long",
				"question": "Choose command approval mode",
				"options": [
					{"label": "Deny", "description": "Do not run it."},
					{"label": "Allow once (Recommended)", "description": "Run once."}
				]
			}
		]
	}`)

	out, err := handleRequestUserInput(context.Background(), args)
	if err != nil {
		t.Fatalf("handleRequestUserInput failed: %v", err)
	}

	var resp struct {
		Questions []struct {
			Header string `json:"header"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if len(resp.Questions) != 1 {
		t.Fatalf("expected exactly one question, got %d", len(resp.Questions))
	}
	if got := resp.Questions[0].Header; len([]rune(got)) > maxQuestionHeaderLength {
		t.Fatalf("expected header length <= %d, got %q", maxQuestionHeaderLength, got)
	}
}

func TestRequestUserInputDerivesHeaderWhenMissing(t *testing.T) {
	args := json.RawMessage(`{
		"questions": [
			{
				"id": "approval_decision",
				"header": "  ",
				"question": "Should we run this command now?",
				"options": [
					{"label": "Deny", "description": "Do not run it."},
					{"label": "Allow once (Recommended)", "description": "Run once."}
				]
			}
		]
	}`)

	out, err := handleRequestUserInput(context.Background(), args)
	if err != nil {
		t.Fatalf("handleRequestUserInput failed: %v", err)
	}

	var resp struct {
		Questions []struct {
			Header string `json:"header"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if len(resp.Questions) != 1 {
		t.Fatalf("expected exactly one question, got %d", len(resp.Questions))
	}
	got := resp.Questions[0].Header
	if strings.TrimSpace(got) == "" {
		t.Fatal("expected derived non-empty header")
	}
	if len([]rune(got)) > maxQuestionHeaderLength {
		t.Fatalf("expected header length <= %d, got %q", maxQuestionHeaderLength, got)
	}
}
