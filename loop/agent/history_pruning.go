package agent

import (
	"bytes"
	"encoding/json"
	"strings"

	"loop/models"
)

const oldToolResultContentCleared = "[Old tool result content cleared]"

var historicalToolPayloadKeys = map[string]struct{}{
	"content":  {},
	"diff":     {},
	"error":    {},
	"output":   {},
	"patch":    {},
	"response": {},
	"result":   {},
	"stderr":   {},
	"stdout":   {},
}

// pruneHistoricalToolResponses rewrites tool-response payloads that occurred
// before the most recent user message. This keeps same-turn tool results intact
// while clearing stale tool output on follow-up turns.
func pruneHistoricalToolResponses(history []*models.Message) []*models.Message {
	lastUserIdx := -1
	for i := len(history) - 1; i >= 0; i-- {
		if history[i] != nil && history[i].SentBy == models.SentByUser {
			lastUserIdx = i
			break
		}
	}
	if lastUserIdx <= 0 {
		return history
	}

	pruned := history
	clonedHistory := false
	for i := 0; i < lastUserIdx; i++ {
		msg := history[i]
		if msg == nil || msg.SentBy != models.SentByTool {
			continue
		}

		next, changed := pruneHistoricalToolResponseMessage(msg)
		if !changed {
			continue
		}
		if !clonedHistory {
			pruned = append([]*models.Message(nil), history...)
			clonedHistory = true
		}
		pruned[i] = next
	}

	return pruned
}

func pruneHistoricalToolResponseMessage(msg *models.Message) (*models.Message, bool) {
	parts := make([]models.MessagePart, len(msg.Parts))
	copy(parts, msg.Parts)

	changed := false
	for i, part := range parts {
		if part.Kind != models.PartFunctionResponse || part.FunctionResponse == nil {
			continue
		}

		nextJSON := pruneHistoricalToolResponseJSON(part.FunctionResponse.ResponseJSON)
		if bytes.Equal(bytes.TrimSpace(nextJSON), bytes.TrimSpace(part.FunctionResponse.ResponseJSON)) {
			continue
		}

		resp := *part.FunctionResponse
		resp.ResponseJSON = nextJSON
		parts[i].FunctionResponse = &resp
		changed = true
	}

	if !changed {
		return msg, false
	}

	clone := *msg
	clone.Parts = parts
	return &clone, true
}

func pruneHistoricalToolResponseJSON(raw json.RawMessage) json.RawMessage {
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return historicalToolPlaceholderJSON()
	}

	root, ok := payload.(map[string]any)
	if !ok {
		return historicalToolPlaceholderJSON()
	}

	pruned, changed := pruneHistoricalToolValue(root)
	if !changed {
		return raw
	}

	normalized, err := json.Marshal(pruned)
	if err != nil {
		return historicalToolPlaceholderJSON()
	}
	return normalized
}

func pruneHistoricalToolValue(value any) (any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		next := make(map[string]any, len(typed))
		changed := false
		for key, child := range typed {
			if shouldPruneHistoricalToolKey(key) {
				next[key] = oldToolResultContentCleared
				changed = true
				continue
			}
			prunedChild, childChanged := pruneHistoricalToolValue(child)
			next[key] = prunedChild
			if childChanged {
				changed = true
			}
		}
		return next, changed
	case []any:
		next := make([]any, len(typed))
		changed := false
		for i, child := range typed {
			prunedChild, childChanged := pruneHistoricalToolValue(child)
			next[i] = prunedChild
			if childChanged {
				changed = true
			}
		}
		return next, changed
	default:
		return value, false
	}
}

func shouldPruneHistoricalToolKey(key string) bool {
	_, ok := historicalToolPayloadKeys[strings.ToLower(strings.TrimSpace(key))]
	return ok
}

func historicalToolPlaceholderJSON() json.RawMessage {
	return json.RawMessage(`{"output":"` + oldToolResultContentCleared + `"}`)
}
