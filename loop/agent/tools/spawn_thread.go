package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/google/uuid"
	"google.golang.org/genai"

	"loop/agent"
	"loop/agent/systeminstruction"
	"loop/models"
	"loop/store"
)

// MaxThreadDepth is the maximum nesting level for sub-agent threads.
// Depth 0 = root, 1 = thread, 2 = grandchild. Spawning at depth >= MaxThreadDepth
// is rejected to prevent unbounded recursion.
const MaxThreadDepth = 2

// spawnThreadArgs is the JSON body expected from the model when it calls spawn_thread.
type spawnThreadArgs struct {
	Title           string `json:"title"`
	Task            string `json:"task"`
	ContextStrategy string `json:"context_strategy"` // "full_chain" | "summary"
	Mode            string `json:"mode"`             // "blocking" | "async"
}

// spawnThreadResult is the JSON returned to the model as the tool response.
type spawnThreadResult struct {
	ThreadID             string `json:"thread_id"`
	Status               string `json:"status"`
	Result               string `json:"result,omitempty"`
	Error                string `json:"error,omitempty"`
	ParentConversationID string `json:"parent_conversation_id,omitempty"`
	AnchorMessageID      string `json:"anchor_message_id,omitempty"`
	Title                string `json:"title,omitempty"`
	Mode                 string `json:"mode,omitempty"`
	ContextStrategy      string `json:"context_strategy,omitempty"`
}

// UIEventEmitter is a function for persisting a UIEvent from within a tool.
// It mirrors the signature of Session.emitUIEvent for injection.
type UIEventEmitter func(kind models.UIEventKind, text string, msgID models.MessageID, metadata map[string]any)

// NewSpawnThreadTool creates the spawn_thread tool definition.
//
// When the model calls this tool it forks the current conversation into a child
// sub-agent that:
//   - Inherits the parent history up to the current head message (full_chain)
//     OR starts fresh with only the task message (summary).
//   - Runs with the same tool set as the parent (depth+1).
//   - Returns a synthesised final answer as ResultMessage.
//
// In blocking mode the parent turn waits for the child to complete before
// returning to the model. In async mode the child runs in a background goroutine
// and the model can later call await_thread to retrieve the result.
func NewSpawnThreadTool(
	s store.Store,
	client agent.ModelClient,
	workspace *models.Workspace,
	parentConv *models.Conversation,
	parentTools []*agent.ToolDef,
	parentDepth int,
	statusEmitters ...func(string),
) *agent.ToolDef {
	var statusEmitter func(string)
	if len(statusEmitters) > 0 {
		statusEmitter = statusEmitters[0]
	}

	decl := &genai.FunctionDeclaration{
		Name: "spawn_thread",
		Description: `Spawn a sub-agent thread to solve a focused task.
The sub-agent inherits the parent conversation context (full_chain) or
starts isolated with only the given task (summary).
Use blocking mode when you need the result before continuing.
Use async mode when you can do other work while the thread runs, then call await_thread later.`,
		Parameters: &genai.Schema{
			Type: genai.TypeObject,
			Properties: map[string]*genai.Schema{
				"title": {
					Type:        genai.TypeString,
					Description: "Short human-readable label for the thread.",
				},
				"task": {
					Type:        genai.TypeString,
					Description: "The question or task for the sub-agent to solve.",
				},
				"context_strategy": {
					Type:        genai.TypeString,
					Description: `"full_chain" to give the sub-agent the full parent history, "summary" to start fresh with only the task.`,
					Enum:        []string{"full_chain", "summary"},
				},
				"mode": {
					Type:        genai.TypeString,
					Description: `"blocking" to wait for the result now, "async" to get a thread_id and await later.`,
					Enum:        []string{"blocking", "async"},
				},
			},
			Required: []string{"title", "task", "context_strategy", "mode"},
		},
	}

	handler := func(ctx context.Context, rawArgs json.RawMessage) (json.RawMessage, error) {
		var args spawnThreadArgs
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return errorJSON("invalid arguments: " + err.Error()), nil
		}

		// ── Depth guard ───────────────────────────────────────────────────────
		if parentDepth >= MaxThreadDepth {
			return errorJSON(fmt.Sprintf(
				"max thread depth (%d) reached; cannot spawn further sub-agents", MaxThreadDepth,
			)), nil
		}

		// ── Resolve context strategy ──────────────────────────────────────────
		strategy := models.ContextStrategyFullChain
		if args.ContextStrategy == string(models.ContextStrategySummary) {
			strategy = models.ContextStrategySummary
		}

		// ── Resolve mode ──────────────────────────────────────────────────────
		mode := models.ThreadModeBlocking
		if args.Mode == string(models.ThreadModeAsync) {
			mode = models.ThreadModeAsync
		}

		// ── Anchor: current head of the parent conversation ───────────────────
		//
		// parentConv may be stale (captured when the session/tool was created).
		// Resolve the latest head from the store so full_chain threads can
		// reliably anchor to an existing parent message.
		anchorMsgID, err := resolveAnchorMessageID(ctx, s, parentConv)
		if err != nil {
			return errorJSON("resolve parent anchor: " + err.Error()), nil
		}
		if strategy == models.ContextStrategyFullChain && anchorMsgID == "" {
			return errorJSON("cannot spawn full_chain thread: parent conversation has no anchor message"), nil
		}

		// ── Create child conversation ─────────────────────────────────────────
		systemPromptID := parentConv.SystemPromptID
		systemPromptName := parentConv.SystemPromptName
		if systemPromptID == "" && systemPromptName == "" {
			variant := systeminstruction.DefaultVariant()
			systemPromptID = variant.ID
			systemPromptName = variant.Name
		}

		childConv := &models.Conversation{
			ID:                   models.ConversationID(uuid.New().String()),
			WorkspaceID:          parentConv.WorkspaceID,
			Title:                args.Title,
			SystemPromptID:       systemPromptID,
			SystemPromptName:     systemPromptName,
			ParentConversationID: parentConv.ID,
			AnchorMessageID:      anchorMsgID,
			ThreadMode:           mode,
			ThreadStatus:         models.ThreadStatusRunning,
			ContextStrategy:      strategy,
		}
		if err := s.Conversations().Create(ctx, childConv); err != nil {
			return errorJSON("create child conversation: " + err.Error()), nil
		}
		emitThreadStatus(statusEmitter, "[thread %s] spawned (%s, mode=%s, anchor=%s, title=%q)",
			shortThreadID(string(childConv.ID)), strategy, mode, shortThreadID(string(anchorMsgID)), args.Title)
		persistThreadUIEvent(s, parentConv.ID, anchorMsgID,
			"thread "+shortThreadID(string(childConv.ID))+" spawned: "+args.Title,
			map[string]any{"thread_id": string(childConv.ID), "status": "spawned", "title": args.Title, "mode": string(mode), "context_strategy": string(strategy)})

		// ── Build child session ───────────────────────────────────────────────
		childSession := agent.NewSession(
			s, client, workspace, childConv,
			parentTools, parentDepth+1,
		)

		runChild := func(runCtx context.Context, anchorMsgID models.MessageID) {
			emitThreadStatus(statusEmitter, "[thread %s] started", shortThreadID(string(childConv.ID)))
			persistThreadUIEvent(s, parentConv.ID, anchorMsgID,
				"thread "+shortThreadID(string(childConv.ID))+" started",
				map[string]any{"thread_id": string(childConv.ID), "status": "started"})
			result, errMsg := driveChildSession(runCtx, childSession, args.Task, childConv.ID, statusEmitter)

			// Persist outcome regardless of error.
			childConv.ResultMessage = result
			if errMsg != "" {
				childConv.ThreadStatus = models.ThreadStatusFailed
				childConv.ResultMessage = errMsg
				emitThreadStatus(statusEmitter, "[thread %s] failed: %s",
					shortThreadID(string(childConv.ID)), errMsg)
				persistThreadUIEvent(s, parentConv.ID, anchorMsgID,
					"thread "+shortThreadID(string(childConv.ID))+" failed: "+errMsg,
					map[string]any{"thread_id": string(childConv.ID), "status": "failed", "error": errMsg})
			} else {
				childConv.ThreadStatus = models.ThreadStatusCompleted
				emitThreadStatus(statusEmitter, "[thread %s] completed",
					shortThreadID(string(childConv.ID)))
				persistThreadUIEvent(s, parentConv.ID, anchorMsgID,
					"thread "+shortThreadID(string(childConv.ID))+" completed",
					map[string]any{"thread_id": string(childConv.ID), "status": "completed"})
			}
			if updateErr := s.Conversations().Update(context.Background(), childConv); updateErr != nil {
				log.Printf("[spawn_thread] update child conv %s: %v", childConv.ID, updateErr)
			}
		}

		switch mode {
		case models.ThreadModeBlocking:
			// Block the parent tool call until the child completes.
			runChild(ctx, anchorMsgID)
			status := "completed"
			if childConv.ThreadStatus == models.ThreadStatusFailed {
				status = "failed"
			}
			return marshalResult(spawnThreadResult{
				ThreadID:             string(childConv.ID),
				Status:               status,
				Result:               childConv.ResultMessage,
				ParentConversationID: string(parentConv.ID),
				AnchorMessageID:      string(anchorMsgID),
				Title:                args.Title,
				Mode:                 string(mode),
				ContextStrategy:      string(strategy),
			})

		default: // async
			go runChild(context.Background(), anchorMsgID)
			emitThreadStatus(statusEmitter, "[thread %s] running in background", shortThreadID(string(childConv.ID)))
			return marshalResult(spawnThreadResult{
				ThreadID:             string(childConv.ID),
				Status:               "running",
				ParentConversationID: string(parentConv.ID),
				AnchorMessageID:      string(anchorMsgID),
				Title:                args.Title,
				Mode:                 string(mode),
				ContextStrategy:      string(strategy),
			})
		}
	}

	return &agent.ToolDef{
		Declaration: decl,
		Handler:     handler,
		Intents: []string{
			"Use when you need to delegate a focused sub-task to a parallel sub-agent",
			"Use blocking mode when you need the result before continuing your current reasoning",
			"Use async mode when you want to work on other things while waiting",
		},
	}
}

func resolveAnchorMessageID(ctx context.Context, s store.Store, parentConv *models.Conversation) (models.MessageID, error) {
	if parentConv == nil {
		return "", fmt.Errorf("parent conversation is required")
	}

	latest := parentConv
	if convFromDB, err := s.Conversations().Get(ctx, parentConv.ID); err == nil && convFromDB != nil {
		latest = convFromDB
	}
	if latest.HeadMessageID != "" {
		return latest.HeadMessageID, nil
	}

	// Fallback if head pointer is missing/outdated: read last persisted message.
	msgs, err := s.Messages().GetRange(ctx, latest.ID, 1, 999999)
	if err != nil {
		return "", err
	}
	if len(msgs) == 0 {
		return "", nil
	}
	return msgs[len(msgs)-1].ID, nil
}

// driveChildSession runs HandleUserMessage and drains the event channel to
// completion, returning the final agent text and any error message.
func driveChildSession(
	ctx context.Context,
	session *agent.Session,
	task string,
	threadID models.ConversationID,
	statusEmitter func(string),
) (result string, errMsg string) {
	parts := []models.MessagePart{{
		Kind: models.PartText,
		Text: &models.TextPart{Text: task},
	}}
	events, cancel, err := session.HandleUserMessage(ctx, parts)
	if err != nil {
		return "", "start session: " + err.Error()
	}
	defer cancel()

	for event := range events {
		switch event.Kind {
		case agent.EventStatus:
			if event.Status != nil && event.Status.Text != "" {
				emitThreadStatus(statusEmitter, "[thread %s] %s", shortThreadID(string(threadID)), event.Status.Text)
			}
		case agent.EventToolCallStart:
			if event.ToolCall != nil && event.ToolCall.Name != "" {
				emitThreadStatus(statusEmitter, "[thread %s] tool start: %s", shortThreadID(string(threadID)), event.ToolCall.Name)
			}
		case agent.EventToolResult:
			if event.ToolResult != nil {
				if event.ToolResult.Success {
					emitThreadStatus(statusEmitter, "[thread %s] tool done: %s",
						shortThreadID(string(threadID)), event.ToolResult.Name)
				} else {
					emitThreadStatus(statusEmitter, "[thread %s] tool failed: %s (%s)",
						shortThreadID(string(threadID)), event.ToolResult.Name, event.ToolResult.Error)
				}
			}
		case agent.EventMessageDone:
			msg, ok := event.Message.(*models.Message)
			if ok && msg.SentBy == models.SentByAgent {
				// Collect the last agent text message as the result.
				for _, part := range msg.Parts {
					if part.Kind == models.PartText && part.Text != nil {
						result = part.Text.Text
					}
				}
			}
		case agent.EventError:
			emitThreadStatus(statusEmitter, "[thread %s] error: %s", shortThreadID(string(threadID)), event.ErrorText)
			errMsg = event.ErrorText
			return
		case agent.EventTurnAborted:
			emitThreadStatus(statusEmitter, "[thread %s] aborted: %s", shortThreadID(string(threadID)), event.ErrorText)
			errMsg = "turn aborted: " + event.ErrorText
			return
		case agent.EventTurnComplete:
			emitThreadStatus(statusEmitter, "[thread %s] turn complete", shortThreadID(string(threadID)))
		}
	}
	return
}

// ── helpers ──────────────────────────────────────────────────────────────────

func errorJSON(msg string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"error": msg})
	return b
}

func marshalResult(r spawnThreadResult) (json.RawMessage, error) {
	b, err := json.Marshal(r)
	if err != nil {
		return errorJSON("marshal result: " + err.Error()), nil
	}
	return b, nil
}

func emitThreadStatus(statusEmitter func(string), format string, args ...any) {
	if statusEmitter == nil {
		return
	}
	statusEmitter(fmt.Sprintf(format, args...))
}

func shortThreadID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// persistThreadUIEvent writes a thread_status UIEvent to the parent conversation's
// ui_events table. It is non-critical: errors are only logged.
func persistThreadUIEvent(
	s store.Store,
	parentConvID models.ConversationID,
	anchorMsgID models.MessageID,
	text string,
	metadata map[string]any,
) {
	evt := &models.UIEvent{
		ID:             uuid.New().String(),
		ConversationID: parentConvID,
		MessageID:      anchorMsgID,
		Kind:           models.UIEventKindThreadStatus,
		Text:           text,
		Metadata:       metadata,
	}
	if err := s.UIEvents().Append(context.Background(), evt); err != nil {
		log.Printf("[spawn_thread] persist thread ui_event: %v", err)
	}
}
