package tools

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/genai"

	"loop/agent"
	"loop/models"
	"loop/store"
)

// awaitThreadArgs is the JSON body expected from the model when it calls await_thread.
type awaitThreadArgs struct {
	ThreadID string `json:"thread_id"`
	Blocking bool   `json:"blocking"` // default true when omitted = caller must explicitly set false to poll
}

// awaitThreadResult is the JSON returned to the model.
type awaitThreadResult struct {
	ThreadID string `json:"thread_id"`
	Status   string `json:"status"`
	Result   string `json:"result,omitempty"`
	Error    string `json:"error,omitempty"`
}

// awaitPollInterval is how often we re-read the DB while blocking.
const awaitPollInterval = 100 * time.Millisecond

// NewAwaitThreadTool creates the await_thread tool definition.
//
// The model calls this tool to check or wait for an async thread's completion.
//
//   - blocking=true (default): polls the store repeatedly until the thread
//     status leaves "running", then returns the result. Respects ctx cancellation.
//   - blocking=false: single read, returns current status + result immediately
//     (useful for non-blocking status checks mid-turn).
func NewAwaitThreadTool(s store.Store, statusEmitters ...func(string)) *agent.ToolDef {
	var statusEmitter func(string)
	if len(statusEmitters) > 0 {
		statusEmitter = statusEmitters[0]
	}

	decl := &genai.FunctionDeclaration{
		Name: "await_thread",
		Description: `Wait for (or poll) a previously spawned async thread.

Use blocking=true (default) to suspend your current reasoning until the thread
finishes and then collect its result.
Use blocking=false to check the status without waiting — useful if you want to
check multiple threads and continue if some are done.`,
		Parameters: &genai.Schema{
			Type: genai.TypeObject,
			Properties: map[string]*genai.Schema{
				"thread_id": {
					Type:        genai.TypeString,
					Description: "The thread_id returned by spawn_thread.",
				},
				"blocking": {
					Type:        genai.TypeBoolean,
					Description: "If true (default), block until the thread completes. If false, return current status immediately.",
				},
			},
			Required: []string{"thread_id"},
		},
	}

	handler := func(ctx context.Context, rawArgs json.RawMessage) (json.RawMessage, error) {
		var args awaitThreadArgs
		// Default blocking = true unless caller explicitly says false.
		args.Blocking = true
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return errorJSON("invalid arguments: " + err.Error()), nil
		}
		if args.ThreadID == "" {
			return errorJSON("thread_id is required"), nil
		}

		convID := models.ConversationID(args.ThreadID)

		if !args.Blocking {
			// Single non-blocking read.
			result, err := readThreadStatus(ctx, s, convID)
			if err != nil {
				return result, err
			}
			emitAwaitStatus(statusEmitter, convID, result, false)
			return result, nil
		}

		// Blocking: poll until status != running, or ctx is cancelled.
		polls := 0
		for {
			result, _ := readThreadStatus(ctx, s, convID)
			polls++

			// Check if the thread has left the running state.
			var r awaitThreadResult
			if jsonErr := json.Unmarshal(result, &r); jsonErr == nil {
				if r.Status != string(models.ThreadStatusRunning) {
					emitAwaitStatus(statusEmitter, convID, result, true)
					return result, nil
				}
				if polls == 1 || polls%30 == 0 {
					emitThreadStatus(statusEmitter, "[thread %s] await: still running", shortThreadID(string(convID)))
				}
			}

			select {
			case <-ctx.Done():
				return errorJSON("await_thread cancelled: " + ctx.Err().Error()), nil
			case <-time.After(awaitPollInterval):
				// Re-read on next iteration.
			}
		}
	}

	return &agent.ToolDef{
		Declaration: decl,
		Handler:     handler,
		Intents: []string{
			"Use after spawn_thread(mode=async) to collect the result",
			"Use blocking=true when you need the result before continuing",
			"Use blocking=false to poll multiple threads without stalling",
		},
	}
}

func emitAwaitStatus(statusEmitter func(string), convID models.ConversationID, result json.RawMessage, blocking bool) {
	if statusEmitter == nil {
		return
	}
	var r awaitThreadResult
	if json.Unmarshal(result, &r) != nil {
		return
	}
	mode := "poll"
	if blocking {
		mode = "await"
	}
	msg := "[thread %s] %s: %s"
	args := []any{shortThreadID(string(convID)), mode, r.Status}
	if r.Error != "" {
		msg += ": %s"
		args = append(args, r.Error)
	}
	emitThreadStatus(statusEmitter, msg, args...)
}

// readThreadStatus loads a conversation by ID and returns its status JSON.
func readThreadStatus(ctx context.Context, s store.Store, convID models.ConversationID) (json.RawMessage, error) {
	conv, err := s.Conversations().Get(ctx, convID)
	if err != nil {
		return errorJSON("thread not found: " + err.Error()), nil
	}

	r := awaitThreadResult{
		ThreadID: string(conv.ID),
		Status:   string(conv.ThreadStatus),
		Result:   conv.ResultMessage,
	}
	if conv.ThreadStatus == models.ThreadStatusFailed {
		r.Error = conv.ResultMessage
		r.Result = ""
	}

	b, err := json.Marshal(r)
	if err != nil {
		return errorJSON("marshal: " + err.Error()), nil
	}
	return b, nil
}
