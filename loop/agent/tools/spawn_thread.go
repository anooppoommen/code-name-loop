package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/google/uuid"
	"google.golang.org/genai"

	"loop/agent"
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
	ThreadID string `json:"thread_id"`
	Status   string `json:"status"`
	Result   string `json:"result,omitempty"`
	Error    string `json:"error,omitempty"`
}

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
	systemPrompt string,
	parentDepth int,
) *agent.ToolDef {
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
		anchorMsgID := parentConv.HeadMessageID

		// ── Create child conversation ─────────────────────────────────────────
		childConv := &models.Conversation{
			ID:                   models.ConversationID(uuid.New().String()),
			WorkspaceID:          parentConv.WorkspaceID,
			Title:                args.Title,
			ParentConversationID: parentConv.ID,
			AnchorMessageID:      anchorMsgID,
			ThreadMode:           mode,
			ThreadStatus:         models.ThreadStatusRunning,
			ContextStrategy:      strategy,
		}
		if err := s.Conversations().Create(ctx, childConv); err != nil {
			return errorJSON("create child conversation: " + err.Error()), nil
		}

		// ── Build child session ───────────────────────────────────────────────
		childSession := agent.NewSession(
			s, client, workspace, childConv,
			systemPrompt, parentTools, parentDepth+1,
		)

		runChild := func(runCtx context.Context) {
			result, errMsg := driveChildSession(runCtx, childSession, args.Task)

			// Persist outcome regardless of error.
			childConv.ResultMessage = result
			if errMsg != "" {
				childConv.ThreadStatus = models.ThreadStatusFailed
				childConv.ResultMessage = errMsg
			} else {
				childConv.ThreadStatus = models.ThreadStatusCompleted
			}
			if updateErr := s.Conversations().Update(context.Background(), childConv); updateErr != nil {
				log.Printf("[spawn_thread] update child conv %s: %v", childConv.ID, updateErr)
			}
		}

		switch mode {
		case models.ThreadModeBlocking:
			// Block the parent tool call until the child completes.
			runChild(ctx)
			status := "completed"
			if childConv.ThreadStatus == models.ThreadStatusFailed {
				status = "failed"
			}
			return marshalResult(spawnThreadResult{
				ThreadID: string(childConv.ID),
				Status:   status,
				Result:   childConv.ResultMessage,
			})

		default: // async
			go runChild(context.Background())
			return marshalResult(spawnThreadResult{
				ThreadID: string(childConv.ID),
				Status:   "running",
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

// driveChildSession runs HandleUserMessage and drains the event channel to
// completion, returning the final agent text and any error message.
func driveChildSession(ctx context.Context, session *agent.Session, task string) (result string, errMsg string) {
	events, cancel, err := session.HandleUserMessage(ctx, task)
	if err != nil {
		return "", "start session: " + err.Error()
	}
	defer cancel()

	for event := range events {
		switch event.Kind {
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
			errMsg = event.ErrorText
			return
		case agent.EventTurnAborted:
			errMsg = "turn aborted: " + event.ErrorText
			return
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
