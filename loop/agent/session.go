package agent

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/google/uuid"

	"loop/agent/systeminstruction"
	"loop/models"
	"loop/store"
)

// MaxToolCallIterations is the maximum number of tool call cycles per turn.
// This prevents runaway agent loops.
const MaxToolCallIterations = 32

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

	// Emit TurnStarted.
	ch <- TurnEvent{Kind: EventTurnStarted}
	ch <- TurnEvent{
		Kind: EventStatus,
		Status: &StatusEvent{
			Text: "turn started",
		},
	}

	iteration := 0

	for {
		iteration++

		// Guard against runaway tool call loops.
		if iteration > MaxToolCallIterations {
			ch <- TurnEvent{
				Kind:      EventError,
				Error:     fmt.Errorf("max tool call iterations (%d) exceeded", MaxToolCallIterations),
				ErrorText: fmt.Sprintf("max tool call iterations (%d) exceeded", MaxToolCallIterations),
			}
			return
		}

		// Check cancellation — emit TurnAborted instead of Error.
		if ctx.Err() != nil {
			ch <- TurnEvent{Kind: EventTurnAborted, ErrorText: ctx.Err().Error()}
			return
		}

		// Step 1: Build conversation history.
		history, err := t.buildHistory(ctx)
		if err != nil {
			ch <- TurnEvent{Kind: EventError, Error: err, ErrorText: err.Error()}
			return
		}

		// Step 2: Stream model response.
		ch <- TurnEvent{
			Kind: EventStatus,
			Status: &StatusEvent{
				Text:      "model call started",
				Iteration: iteration,
			},
		}
		config := &GenerateContentConfig{
			SystemInstruction: s.SystemPrompt,
			Tools:             BuildToolsForModel(s.Tools),
		}

		var agentMsg *models.Message

		for event := range s.Client.StreamMessage(ctx, history, config) {
			switch event.Kind {
			case EventDelta:
				ch <- event

			case EventMessageDone:
				msg, ok := event.Message.(*models.Message)
				if !ok {
					ch <- TurnEvent{Kind: EventError, Error: fmt.Errorf("unexpected message type"), ErrorText: "unexpected message type"}
					return
				}
				agentMsg = msg

			case EventError:
				// Check if this was a cancellation that manifested as a stream error.
				if ctx.Err() != nil {
					ch <- TurnEvent{Kind: EventTurnAborted, ErrorText: ctx.Err().Error()}
					return
				}
				ch <- event
				return
			}
		}

		if agentMsg == nil {
			// If context was cancelled during streaming, report as abort.
			if ctx.Err() != nil {
				ch <- TurnEvent{Kind: EventTurnAborted, ErrorText: ctx.Err().Error()}
				return
			}
			ch <- TurnEvent{Kind: EventError, Error: fmt.Errorf("no response from model"), ErrorText: "no response from model"}
			return
		}

		// Step 3: Persist the agent message.
		agentMsg.ID = models.MessageID(uuid.New().String())
		agentMsg.ConversationID = s.Conversation.ID
		agentMsg.SentBy = models.SentByAgent
		agentMsg.State = models.MessageStateCompleted

		if err := s.Store.Messages().Append(ctx, agentMsg); err != nil {
			ch <- TurnEvent{Kind: EventError, Error: err, ErrorText: err.Error()}
			return
		}

		ch <- TurnEvent{Kind: EventMessageDone, Message: agentMsg}

		// Step 4: Check for function calls.
		functionCalls := extractFunctionCalls(agentMsg)
		if len(functionCalls) == 0 {
			ch <- TurnEvent{
				Kind: EventStatus,
				Status: &StatusEvent{
					Text:      "model produced final response",
					Iteration: iteration,
				},
			}
			ch <- TurnEvent{Kind: EventTurnComplete}
			return
		}
		ch <- TurnEvent{
			Kind: EventStatus,
			Status: &StatusEvent{
				Text:      fmt.Sprintf("executing %d tool call(s)", len(functionCalls)),
				Iteration: iteration,
			},
		}

		// Step 5: Execute tool calls.
		for _, fc := range functionCalls {
			ch <- TurnEvent{
				Kind: EventToolCallStart,
				ToolCall: &ToolCallEvent{
					CallID: fc.CallID,
					Name:   fc.Name,
				},
			}
		}

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
		for i, result := range results {
			toolParts[i] = models.MessagePart{
				Kind: models.PartFunctionResponse,
				FunctionResponse: &models.FunctionResponsePart{
					CallID:       result.CallID,
					Name:         result.Name,
					ResponseJSON: result.ResponseJSON,
				},
			}
			ch <- TurnEvent{
				Kind: EventToolResult,
				ToolResult: &ToolResultEvent{
					CallID:  result.CallID,
					Name:    result.Name,
					Success: result.Err == nil,
					Result:  truncateEventText(string(result.ResponseJSON), 4000),
					Error:   errorString(result.Err),
				},
			}
		}

		toolMsg := &models.Message{
			ID:             models.MessageID(uuid.New().String()),
			ConversationID: s.Conversation.ID,
			SentBy:         models.SentByTool,
			State:          models.MessageStateCompleted,
			Parts:          toolParts,
		}

		if err := s.Store.Messages().Append(ctx, toolMsg); err != nil {
			ch <- TurnEvent{Kind: EventError, Error: err, ErrorText: err.Error()}
			return
		}

		log.Printf("[turn] tool call cycle complete (%d/%d), %d results sent back to model",
			iteration, MaxToolCallIterations, len(results))
		ch <- TurnEvent{
			Kind: EventStatus,
			Status: &StatusEvent{
				Text:      fmt.Sprintf("tool call cycle complete (%d result(s))", len(results)),
				Iteration: iteration,
			},
		}
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
	for _, part := range msg.Parts {
		if part.Kind == models.PartFunctionCall && part.FunctionCall != nil {
			callID := part.FunctionCall.CallID
			if callID == "" {
				callID = uuid.New().String()
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

func truncateEventText(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max] + "...(truncated)"
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
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
	// Depth is the nesting level of this session (0 = root).
	Depth int

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
		Store:        store,
		Client:       client,
		Workspace:    workspace,
		Conversation: conversation,
		SystemPrompt: systeminstruction.Get(),
		Tools:        tools,
		Depth:        depth,
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
func (s *Session) HandleUserMessage(ctx context.Context, text string) (<-chan TurnEvent, context.CancelFunc, error) {
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
		Parts: []models.MessagePart{
			{
				Kind: models.PartText,
				Text: &models.TextPart{Text: text},
			},
		},
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
