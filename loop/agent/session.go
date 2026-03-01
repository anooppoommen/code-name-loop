package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"loop/agent/systeminstruction"
	"loop/models"
	"loop/store"
)

const (
	// DefaultMaxToolCallIterations is the default maximum number of tool call
	// cycles per turn. This prevents runaway loops while allowing sustained
	// debug/fix sessions for realistic coding tasks.
	DefaultMaxToolCallIterations = 96
	// MaxToolCallIterations is retained for backward compatibility in tests.
	MaxToolCallIterations = DefaultMaxToolCallIterations

	thoughtStatusChunkInterval = 10
	thoughtStatusMinChars      = 220
	defaultMaxModelRetries     = 3
	defaultRetryDelay          = 30 * time.Second
	defaultRetryTick           = 1 * time.Second
)

type TurnState string

const (
	StateTurnStarted      TurnState = "turn_started"
	StateHistoryReady     TurnState = "history_ready"
	StateModelWaiting     TurnState = "model_waiting"
	StateModelStreaming   TurnState = "model_streaming"
	StateMessagePersisted TurnState = "message_persisted"
	StateToolDispatching  TurnState = "tool_dispatching"
	StateToolExecuting    TurnState = "tool_executing"
	StateRetryWaiting     TurnState = "retry_waiting"
	StateTurnCompleted    TurnState = "turn_completed"
	StateTurnAborted      TurnState = "turn_aborted"
	StateTurnFailed       TurnState = "turn_failed"
)

// Turn represents a single model interaction cycle within a session.
// A turn may involve multiple model calls if the model requests tool
// execution (the agentic loop).
//
// Lifecycle:
//  1. Emit TurnStarted
//  2. Build conversation history from the store
//  3. Stream model response → emit delta events
//  4. If response contains function calls → execute tools → append results → goto 3
//  5. If response has no function calls → emit TurnComplete
type Turn struct {
	session *Session
	cancel  context.CancelFunc
}

// Run executes the turn loop and returns a channel of TurnEvents.
// The channel is closed when the turn completes or is cancelled.
func (t *Turn) Run(ctx context.Context) <-chan TurnEvent {
	ch := make(chan TurnEvent, 64)

	go func() {
		defer close(ch)
		defer func() {
			if r := recover(); r != nil {
				ch <- TurnEvent{
					Kind:      EventError,
					Error:     fmt.Errorf("turn panic: %v", r),
					ErrorText: fmt.Sprintf("turn panic: %v", r),
				}
			}
		}()

		t.runLoop(ctx, ch)
	}()

	return ch
}

func (t *Turn) runLoop(ctx context.Context, ch chan<- TurnEvent) {
	s := t.session
	var agentMsgID models.MessageID // set after the current iteration's agent message is persisted
	currentState := TurnState("")
	modelName := resolveModelName(s.Client)

	statusMeta := func(iteration int) map[string]any {
		if iteration <= 0 {
			return nil
		}
		return map[string]any{
			"iteration": iteration,
		}
	}

	emitStatus := func(text string, iteration int) {
		ch <- TurnEvent{
			Kind: EventStatus,
			Status: &StatusEvent{
				Text:      text,
				Iteration: iteration,
			},
		}
		s.emitUIEvent(ctx, models.UIEventKindStatus, text, agentMsgID, statusMeta(iteration))
	}

	emitStateTransition := func(from, to TurnState, reason string, iteration, attempt int) {
		ch <- TurnEvent{
			Kind: EventStateTransition,
			StateTransition: &StateTransitionEvent{
				From:      string(from),
				To:        string(to),
				Reason:    reason,
				Iteration: iteration,
				Attempt:   attempt,
			},
		}
		s.emitUIEvent(ctx, models.UIEventKindStateTransition,
			fmt.Sprintf("%s -> %s", from, to), agentMsgID,
			map[string]any{
				"from":      string(from),
				"to":        string(to),
				"reason":    reason,
				"iteration": iteration,
				"attempt":   attempt,
			},
		)
	}

	transition := func(to TurnState, reason string, iteration, attempt int) {
		from := currentState
		if from == to {
			return
		}
		emitStateTransition(from, to, reason, iteration, attempt)
		currentState = to
	}

	emitModelWaitStarted := func(iteration, attempt int, startedAt time.Time) {
		startedISO := startedAt.UTC().Format(time.RFC3339Nano)
		ch <- TurnEvent{
			Kind: EventModelWaitStarted,
			ModelWaitStarted: &ModelWaitStartedEvent{
				Iteration: iteration,
				Attempt:   attempt,
				StartedAt: startedISO,
				Model:     modelName,
			},
		}
		s.emitUIEvent(ctx, models.UIEventKindModelWaitStarted, "model wait started", agentMsgID, map[string]any{
			"iteration":  iteration,
			"attempt":    attempt,
			"started_at": startedISO,
			"model":      modelName,
		})
	}

	emitModelWaitFinished := func(iteration, attempt int, outcome string, timings ModelTiming, tokens *ModelTokenUsage, errText string) {
		ch <- TurnEvent{
			Kind: EventModelWaitFinished,
			ModelWaitFinished: &ModelWaitFinishedEvent{
				Iteration: iteration,
				Attempt:   attempt,
				Outcome:   outcome,
				Timings:   timings,
				Tokens:    tokens,
				Error:     errText,
			},
		}
		meta := map[string]any{
			"iteration": iteration,
			"attempt":   attempt,
			"outcome":   outcome,
			"timings": map[string]any{
				"wait_for_first_token_ms": timings.WaitForFirstTokenMS,
				"stream_ms":               timings.StreamMS,
				"total_ms":                timings.TotalMS,
				"retry_delay_ms":          timings.RetryDelayMS,
			},
		}
		if tokens != nil {
			meta["tokens"] = map[string]any{
				"input":  tokens.Input,
				"output": tokens.Output,
				"cached": tokens.Cached,
			}
		}
		if errText != "" {
			meta["error"] = errText
		}
		s.emitUIEvent(ctx, models.UIEventKindModelWaitFinished, "model wait finished", agentMsgID, meta)
	}

	emitRetry := func(message string, attempt, maxAttempts, secondsRemaining, delaySeconds, iteration int) {
		ch <- TurnEvent{
			Kind: EventRetry,
			Retry: &RetryEvent{
				Message:          message,
				Attempt:          attempt,
				MaxAttempts:      maxAttempts,
				SecondsRemaining: secondsRemaining,
				DelaySeconds:     delaySeconds,
				Iteration:        iteration,
			},
		}
	}

	emitError := func(err error, iteration, attempt int) {
		if err == nil {
			return
		}
		transition(StateTurnFailed, err.Error(), iteration, attempt)
		ch <- TurnEvent{
			Kind:      EventError,
			Error:     err,
			ErrorText: err.Error(),
		}
		s.emitUIEvent(ctx, models.UIEventKindError, err.Error(), agentMsgID, statusMeta(iteration))
	}

	emitAbort := func(text string, iteration, attempt int) {
		transition(StateTurnAborted, text, iteration, attempt)
		ch <- TurnEvent{Kind: EventTurnAborted, ErrorText: text}
		s.emitUIEvent(ctx, models.UIEventKindAbort, text, agentMsgID, statusMeta(iteration))
	}

	// Emit TurnStarted.
	ch <- TurnEvent{Kind: EventTurnStarted}
	transition(StateTurnStarted, "turn started", 0, 0)
	emitStatus("turn started", 0)

	iteration := 0
	maxIterations := s.maxToolCallIterations()

	for {
		iteration++
		agentMsgID = ""

		// Guard against runaway tool call loops.
		if iteration > maxIterations {
			emitError(fmt.Errorf("max tool call iterations (%d) exceeded", maxIterations), iteration, 0)
			return
		}

		// Check cancellation — emit TurnAborted instead of Error.
		if ctx.Err() != nil {
			emitAbort(ctx.Err().Error(), iteration, 0)
			return
		}

		// Step 1: Build conversation history.
		history, err := t.buildHistory(ctx)
		if err != nil {
			emitError(err, iteration, 0)
			return
		}
		transition(StateHistoryReady, "history built", iteration, 0)

		// Step 2: Stream model response.
		thinkingLevel, err := ParseThinkingLevel(s.ThinkingLevel)
		if err != nil {
			thinkingLevel = DefaultThinkingLevel
		}
		includeThoughts := s.IncludeThoughts
		config := &GenerateContentConfig{
			SystemInstruction: s.SystemPrompt,
			Tools:             BuildToolsForModel(s.Tools),
			IncludeThoughts:   &includeThoughts,
			ThinkingLevel:     &thinkingLevel,
		}

		var agentMsg *models.Message

		maxRetries := s.maxModelRetries()
		retryDelay := s.modelRetryDelay()
		retryTick := s.modelRetryTick(retryDelay)

		for attempt := 0; attempt <= maxRetries; attempt++ {
			attemptNumber := attempt + 1
			thoughtChunkCount := 0
			thoughtCharsSinceStatus := 0
			lastThoughtSummary := ""
			shouldRetry := false
			delaySeconds := int(retryDelay.Round(time.Second).Seconds())
			if delaySeconds <= 0 {
				delaySeconds = 1
			}
			attemptStartedAt := time.Now().UTC()
			firstTokenAt := time.Time{}
			var attemptTokens *ModelTokenUsage
			waitEventEmitted := false

			transition(StateModelWaiting, "model attempt started", iteration, attemptNumber)
			emitModelWaitStarted(iteration, attemptNumber, attemptStartedAt)

			if attempt > 0 {
				emitStatus(fmt.Sprintf("model call started (retry attempt %d/%d)", attempt, maxRetries), iteration)
				log.Printf("[turn] conv=%s retrying model call attempt=%d/%d",
					s.Conversation.ID, attempt, maxRetries)
			} else {
				emitStatus("model call started", iteration)
			}

			recordFirstToken := func() {
				if firstTokenAt.IsZero() {
					firstTokenAt = time.Now().UTC()
					transition(StateModelStreaming, "model produced output", iteration, attemptNumber)
				}
			}

			emitWaitFinished := func(outcome, errText string, retryDelayMillis int64) {
				if waitEventEmitted {
					return
				}
				waitEventEmitted = true
				endedAt := time.Now().UTC()
				waitMS := int64(0)
				streamMS := int64(0)
				if !firstTokenAt.IsZero() {
					waitMS = firstTokenAt.Sub(attemptStartedAt).Milliseconds()
					if waitMS < 0 {
						waitMS = 0
					}
					streamMS = endedAt.Sub(firstTokenAt).Milliseconds()
					if streamMS < 0 {
						streamMS = 0
					}
				}
				totalMS := endedAt.Sub(attemptStartedAt).Milliseconds()
				if totalMS < 0 {
					totalMS = 0
				}
				emitModelWaitFinished(iteration, attemptNumber, outcome, ModelTiming{
					WaitForFirstTokenMS: waitMS,
					StreamMS:            streamMS,
					TotalMS:             totalMS,
					RetryDelayMS:        retryDelayMillis,
				}, attemptTokens, errText)
			}

		StreamLoop:
			for event := range s.Client.StreamMessage(ctx, history, config) {
				switch event.Kind {
				case EventDelta:
					recordFirstToken()
					ch <- event
					if event.Delta != nil && event.Delta.IsThought {
						thoughtChunkCount++
						if strings.TrimSpace(event.Delta.Text) != "" {
							s.emitUIEvent(ctx, models.UIEventKindThought, event.Delta.Text, agentMsgID, map[string]any{
								"iteration":   iteration,
								"chunk_index": thoughtChunkCount,
							})
						}
						thoughtCharsSinceStatus += len(strings.TrimSpace(event.Delta.Text))

						if summary := extractThoughtSummary(event.Delta.Text); summary != "" && summary != lastThoughtSummary {
							lastThoughtSummary = summary
							emitStatus("thinking: "+summary, iteration)
							thoughtCharsSinceStatus = 0
						} else if thoughtCharsSinceStatus >= thoughtStatusMinChars || thoughtChunkCount%thoughtStatusChunkInterval == 0 {
							emitStatus(fmt.Sprintf("thinking... (%d thought updates)", thoughtChunkCount), iteration)
							thoughtCharsSinceStatus = 0
						}
					}

				case EventMessageDone:
					recordFirstToken()
					msg, ok := event.Message.(*models.Message)
					if !ok {
						emitWaitFinished("error", "unexpected message type", 0)
						emitError(fmt.Errorf("unexpected message type"), iteration, attemptNumber)
						return
					}
					agentMsg = msg
					attemptTokens = extractTokenUsage(msg)

				case EventError:
					// Check if this was a cancellation that manifested as a stream error.
					if ctx.Err() != nil {
						emitWaitFinished("aborted", ctx.Err().Error(), 0)
						emitAbort(ctx.Err().Error(), iteration, attemptNumber)
						return
					}
					msg := strings.TrimSpace(event.ErrorText)
					if msg == "" && event.Error != nil {
						msg = event.Error.Error()
					}

					if isServiceUnavailableError(msg) {
						if attempt < maxRetries {
							emitWaitFinished("retry", msg, retryDelay.Milliseconds())
							transition(StateRetryWaiting, "retryable model error", iteration, attemptNumber)
							retryMsg := fmt.Sprintf("Service unavailable (503). Retrying in %d seconds... (attempt %d/%d)", delaySeconds, attemptNumber, maxRetries)
							emitStatus(retryMsg, iteration)
							emitRetry(retryMsg, attemptNumber, maxRetries, delaySeconds, delaySeconds, iteration)
							log.Printf("[turn] conv=%s transient 503; scheduling retry attempt=%d/%d delay=%s",
								s.Conversation.ID, attemptNumber, maxRetries, retryDelay)
							shouldRetry = true
							break StreamLoop
						}
						log.Printf("[turn] conv=%s transient 503; retries exhausted max=%d",
							s.Conversation.ID, maxRetries)
					}

					if msg == "" {
						msg = "model stream failed"
					}
					emitWaitFinished("error", msg, 0)
					emitError(fmt.Errorf("%s", msg), iteration, attemptNumber)
					return
				}
			}

			if shouldRetry {
				remaining := retryDelay
				for remaining > 0 {
					wait := retryTick
					if wait > remaining {
						wait = remaining
					}

					select {
					case <-ctx.Done():
						emitAbort(ctx.Err().Error(), iteration, attemptNumber)
						return
					case <-time.After(wait):
					}

					remaining -= wait
					if remaining <= 0 {
						break
					}

					secondsRemaining := int((remaining + (time.Second - time.Nanosecond)) / time.Second)
					if secondsRemaining <= 0 {
						secondsRemaining = 1
					}
					retryMsg := fmt.Sprintf("Service unavailable (503). Retrying in %d seconds... (attempt %d/%d)", secondsRemaining, attemptNumber, maxRetries)
					emitRetry(retryMsg, attemptNumber, maxRetries, secondsRemaining, delaySeconds, iteration)
				}
				emitRetry(fmt.Sprintf("Retrying now... (attempt %d/%d)", attemptNumber, maxRetries),
					attemptNumber, maxRetries, 0, delaySeconds, iteration)
				continue
			}
			if agentMsg == nil {
				emitWaitFinished("error", "no response from model", 0)
				break
			}
			emitWaitFinished("success", "", 0)
			break
		} // end retry loop

		if agentMsg == nil {
			// If context was cancelled during streaming, report as abort.
			if ctx.Err() != nil {
				emitAbort(ctx.Err().Error(), iteration, 0)
				return
			}
			emitError(fmt.Errorf("no response from model"), iteration, 0)
			return
		}

		// Step 3: Persist the agent message.
		ensureFunctionCallIDs(agentMsg)
		agentMsg.ID = models.MessageID(uuid.New().String())
		agentMsg.ConversationID = s.Conversation.ID
		agentMsg.SentBy = models.SentByAgent
		agentMsg.State = models.MessageStateCompleted

		if err := s.Store.Messages().Append(ctx, agentMsg); err != nil {
			emitError(err, iteration, 0)
			return
		}
		transition(StateMessagePersisted, "agent message persisted", iteration, 0)
		// Record the persisted message ID so subsequent UIEvents reference it.
		agentMsgID = agentMsg.ID

		ch <- TurnEvent{Kind: EventMessageDone, Message: agentMsg}

		// Step 4: Check for function calls.
		functionCalls := extractFunctionCalls(agentMsg)
		if len(functionCalls) == 0 {
			emitStatus("model produced final response", iteration)
			emitStatus("turn complete", iteration)
			transition(StateTurnCompleted, "turn complete", iteration, 0)
			ch <- TurnEvent{Kind: EventTurnComplete}
			return
		}
		transition(StateToolDispatching, "tool calls requested", iteration, 0)
		emitStatus(fmt.Sprintf("executing %d tool call(s): %s", len(functionCalls), summarizeToolList(functionCalls)), iteration)

		// Step 5: Execute tool calls.
		for i, fc := range functionCalls {
			toolAction := summarizeToolAction(fc, i+1, len(functionCalls))
			emitStatus(toolAction, iteration)

			argsStr := string(fc.Args)
			if fc.Name != "apply_patch" {
				argsStr = truncateJSONTextValues(argsStr, 2000)
			}

			ch <- TurnEvent{
				Kind: EventToolCallStart,
				ToolCall: &ToolCallEvent{
					CallID: fc.CallID,
					Name:   fc.Name,
					Args:   argsStr,
				},
			}
			s.emitUIEvent(ctx, models.UIEventKindToolStart,
				toolAction, agentMsgID,
				map[string]any{
					"call_id":   fc.CallID,
					"tool_name": fc.Name,
					"args":      argsStr,
					"iteration": iteration,
					"index":     i + 1,
					"total":     len(functionCalls),
				},
			)
		}
		transition(StateToolExecuting, "tool execution started", iteration, 0)

		registry := NewToolRegistry(s.Tools)
		toolRequests := make([]ToolCallRequest, len(functionCalls))
		for i, fc := range functionCalls {
			toolRequests[i] = ToolCallRequest{
				CallID: fc.CallID,
				Name:   fc.Name,
				Args:   fc.Args,
			}
		}

		results := ExecuteToolCalls(ctx, toolRequests, registry)

		// Step 6: Persist tool results as a tool message and emit events.
		toolParts := make([]models.MessagePart, len(results))
		successCount := 0
		for i, result := range results {
			toolParts[i] = models.MessagePart{
				Kind: models.PartFunctionResponse,
				FunctionResponse: &models.FunctionResponsePart{
					CallID:       result.CallID,
					Name:         result.Name,
					ResponseJSON: result.ResponseJSON,
				},
			}
			if result.Err == nil {
				successCount++
			}

			resultText := string(result.ResponseJSON)
			if result.Name != "apply_patch" {
				resultText = truncateJSONTextValues(resultText, 4000)
			}

			errorText := errorString(result.Err)
			ch <- TurnEvent{
				Kind: EventToolResult,
				ToolResult: &ToolResultEvent{
					CallID:  result.CallID,
					Name:    result.Name,
					Success: result.Err == nil,
					Result:  resultText,
					Error:   errorText,
				},
			}
			statusText := summarizeToolResultStatus(result, i+1, len(results))
			s.emitUIEvent(ctx, models.UIEventKindToolResult,
				statusText, agentMsgID,
				map[string]any{
					"call_id":   result.CallID,
					"tool_name": result.Name,
					"success":   result.Err == nil,
					"error":     errorText,
					"result":    resultText,
					"iteration": iteration,
					"index":     i + 1,
					"total":     len(results),
				},
			)
			emitStatus(statusText, iteration)
		}

		toolMsg := &models.Message{
			ID:             models.MessageID(uuid.New().String()),
			ConversationID: s.Conversation.ID,
			SentBy:         models.SentByTool,
			State:          models.MessageStateCompleted,
			Parts:          toolParts,
		}

		if err := s.Store.Messages().Append(ctx, toolMsg); err != nil {
			emitError(err, iteration, 0)
			return
		}

		log.Printf("[turn] tool call cycle complete (%d/%d), %d results sent back to model",
			iteration, maxIterations, len(results))
		emitStatus(fmt.Sprintf("tool call cycle complete (%d success, %d failed)", successCount, len(results)-successCount), iteration)
		transition(StateHistoryReady, "tool results persisted", iteration, 0)
	}
}

// buildHistory loads the full conversation history including parent context
// for threaded conversations.
func (t *Turn) buildHistory(ctx context.Context) ([]*models.Message, error) {
	s := t.session
	conv := s.Conversation

	if conv.IsThread() {
		// Summary strategy: skip the parent walk; the sub-agent only sees
		// its own messages. Useful for isolated, focused sub-tasks.
		if conv.ContextStrategy == models.ContextStrategySummary {
			return s.Store.Messages().GetRange(ctx, conv.ID, 1, 999999)
		}

		// Full-chain strategy (default): reconstruct the full ancestor prefix
		// from root through each anchor point, then append this thread's msgs.
		msgs, err := s.Store.Messages().GetRange(ctx, conv.ID, 1, 999999)
		if err != nil {
			return nil, fmt.Errorf("get thread messages: %w", err)
		}
		if len(msgs) == 0 {
			return nil, nil
		}
		maxSeq := msgs[len(msgs)-1].Seq
		return s.Store.Messages().GetParentHistory(ctx, conv.ID, maxSeq)
	}

	return s.Store.Messages().GetRange(ctx, conv.ID, 1, 999999)
}

// extractFunctionCalls pulls all function call parts from a message.
func extractFunctionCalls(msg *models.Message) []ToolCallRequest {
	var calls []ToolCallRequest
	for i := range msg.Parts {
		part := &msg.Parts[i]
		if part.Kind == models.PartFunctionCall && part.FunctionCall != nil {
			callID := part.FunctionCall.CallID
			if callID == "" {
				callID = uuid.New().String()
				part.FunctionCall.CallID = callID
			}
			calls = append(calls, ToolCallRequest{
				CallID: callID,
				Name:   part.FunctionCall.Name,
				Args:   part.FunctionCall.ArgsJSON,
			})
		}
	}
	return calls
}

func ensureFunctionCallIDs(msg *models.Message) {
	if msg == nil {
		return
	}
	for i := range msg.Parts {
		part := &msg.Parts[i]
		if part.Kind == models.PartFunctionCall && part.FunctionCall != nil && part.FunctionCall.CallID == "" {
			part.FunctionCall.CallID = uuid.New().String()
		}
	}
}

func truncateEventText(s string, max int) string {
	if max <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "...(truncated)"
}

func truncateJSONTextValues(raw string, max int) string {
	if max <= 0 {
		return raw
	}

	var payload any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return truncateEventText(raw, max)
	}

	truncateAnyText(payload, max)

	normalized, err := json.Marshal(payload)
	if err != nil {
		return truncateEventText(raw, max)
	}
	return string(normalized)
}

func truncateAnyText(v any, max int) {
	switch t := v.(type) {
	case map[string]any:
		for key := range t {
			switch tv := t[key].(type) {
			case string:
				t[key] = truncateEventText(tv, max)
			default:
				truncateAnyText(tv, max)
			}
		}
	case []any:
		for i := range t {
			switch tv := t[i].(type) {
			case string:
				t[i] = truncateEventText(tv, max)
			default:
				truncateAnyText(tv, max)
			}
		}
	}
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func extractThoughtSummary(deltaText string) string {
	trimmed := strings.TrimSpace(deltaText)
	if trimmed == "" {
		return ""
	}

	// Prefer markdown-style heading snippets: **Heading**
	if idx := strings.Index(trimmed, "**"); idx >= 0 {
		rest := trimmed[idx+2:]
		if end := strings.Index(rest, "**"); end > 0 {
			head := normalizeThoughtSummary(rest[:end])
			if len(head) >= 10 {
				return truncateEventText(head, 120)
			}
		}
	}

	for _, line := range strings.Split(trimmed, "\n") {
		candidate := normalizeThoughtSummary(line)
		if len(candidate) >= 20 {
			return truncateEventText(candidate, 120)
		}
	}
	return ""
}

func normalizeThoughtSummary(line string) string {
	cleaned := strings.TrimSpace(line)
	cleaned = strings.TrimLeft(cleaned, "#*-`> ")
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	return cleaned
}

func summarizeToolList(calls []ToolCallRequest) string {
	if len(calls) == 0 {
		return "none"
	}
	names := make([]string, 0, len(calls))
	for _, c := range calls {
		names = append(names, c.Name)
	}
	joined := strings.Join(names, ", ")
	return truncateEventText(joined, 140)
}

func summarizeToolAction(call ToolCallRequest, idx, total int) string {
	prefix := fmt.Sprintf("tool %d/%d %s", idx, total, call.Name)
	arg := summarizeToolArgs(call.Name, call.Args)
	if arg == "" {
		return prefix
	}
	return prefix + ": " + arg
}

func summarizeToolResultStatus(result ToolCallResponse, idx, total int) string {
	prefix := fmt.Sprintf("tool %d/%d %s", idx, total, result.Name)

	if result.Err != nil {
		return prefix + " failed: " + truncateEventText(result.Err.Error(), 140)
	}

	if result.Name == "spawn_thread" {
		var parsed struct {
			ThreadID string `json:"thread_id"`
			Status   string `json:"status"`
			Error    string `json:"error,omitempty"`
		}
		if json.Unmarshal(result.ResponseJSON, &parsed) == nil && parsed.ThreadID != "" {
			msg := fmt.Sprintf("%s thread %s is %s", prefix, shortThreadID(parsed.ThreadID), parsed.Status)
			if parsed.Error != "" {
				msg += ": " + truncateEventText(parsed.Error, 120)
			}
			return msg
		}
	}

	if result.Name == "await_thread" {
		var parsed struct {
			ThreadID string `json:"thread_id"`
			Status   string `json:"status"`
			Result   string `json:"result,omitempty"`
			Error    string `json:"error,omitempty"`
		}
		if json.Unmarshal(result.ResponseJSON, &parsed) == nil && parsed.ThreadID != "" {
			msg := fmt.Sprintf("%s thread %s %s", prefix, shortThreadID(parsed.ThreadID), parsed.Status)
			if parsed.Error != "" {
				msg += ": " + truncateEventText(parsed.Error, 120)
			}
			return msg
		}
	}

	outSummary := summarizeToolOutput(result.ResponseJSON)
	if outSummary == "" {
		return prefix + " completed"
	}
	return prefix + " completed: " + outSummary
}

func summarizeToolArgs(name string, args json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(args, &m); err != nil {
		return ""
	}

	switch name {
	case "shell":
		if cmd, ok := m["command"].(string); ok {
			return truncateEventText(firstLine(cmd), 120)
		}
	case "exec_command":
		if cmd, ok := m["cmd"].(string); ok {
			return truncateEventText(firstLine(cmd), 120)
		}
	case "apply_patch":
		if input, ok := m["input"].(string); ok {
			patch := summarizePatchTarget(input)
			if patch != "" {
				return patch
			}
		}
	case "read_file":
		if p, ok := m["file_path"].(string); ok {
			return truncateEventText(p, 120)
		}
	case "list_dir":
		if p, ok := m["dir_path"].(string); ok {
			return truncateEventText(p, 120)
		}
	case "grep_files":
		pat, _ := m["pattern"].(string)
		path, _ := m["path"].(string)
		if pat != "" && path != "" {
			return truncateEventText(fmt.Sprintf("pattern=%q path=%s", pat, path), 120)
		}
		if pat != "" {
			return truncateEventText(fmt.Sprintf("pattern=%q", pat), 120)
		}
	case "spawn_thread":
		title, _ := m["title"].(string)
		mode, _ := m["mode"].(string)
		strategy, _ := m["context_strategy"].(string)
		parts := make([]string, 0, 3)
		if title != "" {
			parts = append(parts, "title="+title)
		}
		if mode != "" {
			parts = append(parts, "mode="+mode)
		}
		if strategy != "" {
			parts = append(parts, "context="+strategy)
		}
		if len(parts) > 0 {
			return truncateEventText(strings.Join(parts, ", "), 120)
		}
	case "await_thread":
		threadID, _ := m["thread_id"].(string)
		blocking := "true"
		if b, ok := m["blocking"].(bool); ok {
			if !b {
				blocking = "false"
			}
		}
		if threadID != "" {
			return fmt.Sprintf("thread=%s blocking=%s", shortThreadID(threadID), blocking)
		}
	case "update_plan":
		if plan, ok := m["plan"].([]any); ok {
			return fmt.Sprintf("steps=%d", len(plan))
		}
	case "request_user_input":
		if questions, ok := m["questions"].([]any); ok {
			return fmt.Sprintf("questions=%d", len(questions))
		}
	case "parallel_tool_use":
		if toolUses, ok := m["tool_uses"].([]any); ok {
			return fmt.Sprintf("tool_uses=%d", len(toolUses))
		}
	}

	return ""
}

func summarizePatchTarget(input string) string {
	for _, line := range strings.Split(input, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "*** Update File: "):
			return "update " + strings.TrimSpace(strings.TrimPrefix(line, "*** Update File: "))
		case strings.HasPrefix(line, "*** Add File: "):
			return "add " + strings.TrimSpace(strings.TrimPrefix(line, "*** Add File: "))
		case strings.HasPrefix(line, "*** Delete File: "):
			return "delete " + strings.TrimSpace(strings.TrimPrefix(line, "*** Delete File: "))
		}
	}
	return ""
}

func summarizeToolOutput(raw json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	if e, ok := m["error"].(string); ok && e != "" {
		return "error=" + truncateEventText(e, 120)
	}
	if out, ok := m["output"].(string); ok && strings.TrimSpace(out) != "" {
		return truncateEventText(firstLine(out), 120)
	}
	if successCount, ok := m["success_count"].(float64); ok {
		if failureCount, ok2 := m["failure_count"].(float64); ok2 {
			return fmt.Sprintf("success=%d failed=%d", int(successCount), int(failureCount))
		}
		return fmt.Sprintf("success=%d", int(successCount))
	}
	if questions, ok := m["questions"].([]any); ok {
		return fmt.Sprintf("questions=%d", len(questions))
	}
	return ""
}

func firstLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) == 0 {
		return ""
	}
	return strings.TrimSpace(lines[0])
}

func isServiceUnavailableError(msg string) bool {
	normalized := strings.ToLower(strings.TrimSpace(msg))
	if normalized == "" {
		return false
	}
	return strings.Contains(normalized, "503") ||
		strings.Contains(normalized, "service unavailable") ||
		strings.Contains(normalized, "serviceunavailable")
}

func shortThreadID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

func resolveModelName(client ModelClient) string {
	if client == nil {
		return ""
	}
	type modelNamer interface {
		Model() string
	}
	if namer, ok := client.(modelNamer); ok {
		return namer.Model()
	}
	return ""
}

func extractTokenUsage(msg *models.Message) *ModelTokenUsage {
	if msg == nil || msg.Metadata == nil {
		return nil
	}
	input, inOK := numberToInt64(msg.Metadata["tokens_input"])
	output, outOK := numberToInt64(msg.Metadata["tokens_output"])
	cached, cacheOK := numberToInt64(msg.Metadata["tokens_cached"])
	if !inOK && !outOK && !cacheOK {
		return nil
	}
	return &ModelTokenUsage{
		Input:  input,
		Output: output,
		Cached: cached,
	}
}

func numberToInt64(v any) (int64, bool) {
	switch t := v.(type) {
	case int:
		return int64(t), true
	case int8:
		return int64(t), true
	case int16:
		return int64(t), true
	case int32:
		return int64(t), true
	case int64:
		return t, true
	case uint:
		return int64(t), true
	case uint8:
		return int64(t), true
	case uint16:
		return int64(t), true
	case uint32:
		return int64(t), true
	case uint64:
		return int64(t), true
	case float32:
		return int64(t), true
	case float64:
		return int64(t), true
	default:
		return 0, false
	}
}

// Session represents an active agent session tied to a workspace and
// conversation. It manages the conversation lifecycle and provides
// the main entry point for user interaction.
//
// It owns the conversation state, tools, system prompt, and mediates
// between the user and the model.
//
// Thread-safe: the activeTurn mutex protects against concurrent turn spawning.
// HandleUserMessage cancels any running turn before starting a new one.
//
// Depth tracks nesting level for sub-agent sessions.
// Depth 0 = root; Depth 1 = thread; Depth 2 = grandchild.
// spawn_thread refuses to spawn when Depth >= 2.
type Session struct {
	Store        store.Store
	Client       ModelClient
	Workspace    *models.Workspace
	Conversation *models.Conversation
	SystemPrompt string
	Tools        []*ToolDef
	// IncludeThoughts controls whether thought parts are requested from the model.
	IncludeThoughts bool
	// ThinkingLevel is the user-selected level for this session/turn.
	// Allowed values: minimal, low, medium, high.
	ThinkingLevel string
	// Depth is the nesting level of this session (0 = root).
	Depth int
	// MaxToolCallIterations caps tool-call cycles for this session.
	// If <= 0, DefaultMaxToolCallIterations is used.
	MaxToolCallIterations int
	// MaxModelRetries controls retry count for transient model failures (503).
	// If <= 0, defaultMaxModelRetries is used.
	MaxModelRetries int
	// RetryDelay controls backoff duration for transient model failures.
	// If <= 0, defaultRetryDelay is used.
	RetryDelay time.Duration
	// RetryTick controls retry countdown update frequency.
	// If <= 0, defaultRetryTick is used.
	RetryTick time.Duration

	// mu protects activeTurnCancel.
	mu               sync.Mutex
	activeTurnCancel context.CancelFunc
}

// NewSession creates a new agent session.
func NewSession(
	store store.Store,
	client ModelClient,
	workspace *models.Workspace,
	conversation *models.Conversation,
	tools []*ToolDef,
	depth int,
) *Session {
	return &Session{
		Store:                 store,
		Client:                client,
		Workspace:             workspace,
		Conversation:          conversation,
		SystemPrompt:          systeminstruction.Get(),
		Tools:                 tools,
		IncludeThoughts:       true,
		ThinkingLevel:         "medium",
		Depth:                 depth,
		MaxToolCallIterations: DefaultMaxToolCallIterations,
		MaxModelRetries:       defaultMaxModelRetries,
		RetryDelay:            defaultRetryDelay,
		RetryTick:             defaultRetryTick,
	}
}

func (s *Session) maxToolCallIterations() int {
	if s == nil || s.MaxToolCallIterations <= 0 {
		return DefaultMaxToolCallIterations
	}
	return s.MaxToolCallIterations
}

func (s *Session) maxModelRetries() int {
	if s == nil || s.MaxModelRetries <= 0 {
		return defaultMaxModelRetries
	}
	return s.MaxModelRetries
}

func (s *Session) modelRetryDelay() time.Duration {
	if s == nil || s.RetryDelay <= 0 {
		return defaultRetryDelay
	}
	return s.RetryDelay
}

func (s *Session) modelRetryTick(delay time.Duration) time.Duration {
	if delay <= 0 {
		delay = defaultRetryDelay
	}
	tick := defaultRetryTick
	if s != nil && s.RetryTick > 0 {
		tick = s.RetryTick
	}
	if tick <= 0 {
		tick = defaultRetryTick
	}
	if tick > delay {
		return delay
	}
	return tick
}

// emitUIEvent persists a single UIEvent to the store.
// It is non-critical: errors are logged but do not fail the turn.
// msgID may be empty for events that precede the first persisted agent message
// in a given iteration (e.g. thought deltas before the agent message is saved).
func (s *Session) emitUIEvent(
	ctx context.Context,
	kind models.UIEventKind,
	text string,
	msgID models.MessageID,
	metadata map[string]any,
) {
	persistCtx := ctx
	if persistCtx == nil || persistCtx.Err() != nil {
		detachedCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		persistCtx = detachedCtx
	}

	evt := &models.UIEvent{
		ConversationID: s.Conversation.ID,
		MessageID:      msgID,
		Kind:           kind,
		Text:           text,
		Metadata:       metadata,
	}
	if err := s.Store.UIEvents().Append(persistCtx, evt); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return
		}
		log.Printf("[session] emitUIEvent %s: %v", kind, err)
	}
}

// HandleUserMessage is the main entry point for user interaction.
// It appends the user's message to the conversation, creates a new Turn,
// and returns a channel of events representing the agent's response.
//
// This method cancels any previously running turn before starting the new
// one (abort-before-spawn pattern).
//
// The returned context.CancelFunc can be used to cancel the turn.
func (s *Session) HandleUserMessage(ctx context.Context, parts []models.MessagePart) (<-chan TurnEvent, context.CancelFunc, error) {
	// Abort any previously running turn.
	s.mu.Lock()
	if s.activeTurnCancel != nil {
		s.activeTurnCancel()
	}
	s.mu.Unlock()

	// Create and persist the user message.
	userMsg := &models.Message{
		ID:             models.MessageID(uuid.New().String()),
		ConversationID: s.Conversation.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts:          parts,
	}

	if err := s.Store.Messages().Append(ctx, userMsg); err != nil {
		return nil, nil, fmt.Errorf("append user message: %w", err)
	}

	// Create a cancellable context for the turn.
	turnCtx, cancel := context.WithCancel(ctx)

	// Track the active turn for abort-before-spawn.
	s.mu.Lock()
	s.activeTurnCancel = cancel
	s.mu.Unlock()

	turn := &Turn{
		session: s,
		cancel:  cancel,
	}

	ch := turn.Run(turnCtx)
	return ch, cancel, nil
}
