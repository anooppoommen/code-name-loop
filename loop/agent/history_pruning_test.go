package agent

import (
	"encoding/json"
	"testing"

	"loop/models"
)

func TestPruneHistoricalToolResponses_OnlyTouchesMessagesBeforeLatestUser(t *testing.T) {
	history := []*models.Message{
		{
			SentBy: models.SentByUser,
			Parts:  []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "first turn"}}},
		},
		{
			SentBy: models.SentByTool,
			Parts: []models.MessagePart{{
				Kind: models.PartFunctionResponse,
				FunctionResponse: &models.FunctionResponsePart{
					CallID:       "old-call",
					Name:         "exec_command",
					ResponseJSON: json.RawMessage(`{"output":"old output","session_id":17}`),
				},
			}},
		},
		{
			SentBy: models.SentByUser,
			Parts:  []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "follow up"}}},
		},
		{
			SentBy: models.SentByTool,
			Parts: []models.MessagePart{{
				Kind: models.PartFunctionResponse,
				FunctionResponse: &models.FunctionResponsePart{
					CallID:       "fresh-call",
					Name:         "exec_command",
					ResponseJSON: json.RawMessage(`{"output":"fresh output","session_id":42}`),
				},
			}},
		},
	}

	pruned := pruneHistoricalToolResponses(history)

	oldResp := pruned[1].Parts[0].FunctionResponse
	if got := decodeRawMap(t, oldResp.ResponseJSON)["output"]; got != oldToolResultContentCleared {
		t.Fatalf("old output = %#v, want %q", got, oldToolResultContentCleared)
	}
	if got := decodeRawMap(t, oldResp.ResponseJSON)["session_id"]; got != float64(17) {
		t.Fatalf("old session_id = %#v, want 17", got)
	}

	freshResp := pruned[3].Parts[0].FunctionResponse
	if got := decodeRawMap(t, freshResp.ResponseJSON)["output"]; got != "fresh output" {
		t.Fatalf("fresh output = %#v, want fresh output", got)
	}

	originalOldResp := history[1].Parts[0].FunctionResponse
	if got := decodeRawMap(t, originalOldResp.ResponseJSON)["output"]; got != "old output" {
		t.Fatalf("original history mutated, output = %#v", got)
	}
}

func TestPruneHistoricalToolResponseJSON_PrunesNestedResponsesAndPreservesHandles(t *testing.T) {
	raw := json.RawMessage(`{
		"results": [
			{
				"name": "read_file",
				"success": true,
				"response": {"output": "file body", "success": true}
			},
			{
				"name": "spawn_thread",
				"success": true,
				"response": {"thread_id": "thread-123", "status": "running", "result": "child answer"}
			}
		],
		"total": 2,
		"success_count": 2
	}`)

	pruned := decodeRawMap(t, pruneHistoricalToolResponseJSON(raw))
	results, ok := pruned["results"].([]any)
	if !ok || len(results) != 2 {
		t.Fatalf("results = %#v", pruned["results"])
	}

	first := results[0].(map[string]any)
	firstResp := first["response"]
	if firstResp != oldToolResultContentCleared {
		t.Fatalf("first response = %#v, want placeholder", firstResp)
	}

	second := results[1].(map[string]any)
	secondResp, ok := second["response"].(string)
	if !ok || secondResp != oldToolResultContentCleared {
		t.Fatalf("second response = %#v, want placeholder", second["response"])
	}
}

func TestPruneHistoricalToolResponseJSON_PreservesThreadFieldsWhenPruningResult(t *testing.T) {
	raw := json.RawMessage(`{
		"thread_id": "thread-123",
		"status": "completed",
		"result": "child answer",
		"parent_conversation_id": "parent-1"
	}`)

	pruned := decodeRawMap(t, pruneHistoricalToolResponseJSON(raw))
	if got := pruned["thread_id"]; got != "thread-123" {
		t.Fatalf("thread_id = %#v, want thread-123", got)
	}
	if got := pruned["status"]; got != "completed" {
		t.Fatalf("status = %#v, want completed", got)
	}
	if got := pruned["result"]; got != oldToolResultContentCleared {
		t.Fatalf("result = %#v, want placeholder", got)
	}
	if got := pruned["parent_conversation_id"]; got != "parent-1" {
		t.Fatalf("parent_conversation_id = %#v, want parent-1", got)
	}
}

func decodeRawMap(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal %s: %v", string(raw), err)
	}
	return out
}
