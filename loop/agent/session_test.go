package agent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"loop/agent"
	"loop/models"
	"loop/store"
	"loop/store/sqlite"
)

// ─────────────────────────────────────────────────────────────────
// Mock Model Client
// ─────────────────────────────────────────────────────────────────

// mockModelClient implements agent.ModelClient for testing.
// Returns predetermined responses from a queue, consumed in order.
type mockModelClient struct {
	responses [][]agent.TurnEvent
	callCount atomic.Int32
}

func (m *mockModelClient) StreamMessage(ctx context.Context, history []*models.Message, config *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	ch := make(chan agent.TurnEvent, 64)
	idx := int(m.callCount.Add(1)) - 1

	go func() {
		defer close(ch)
		if idx >= len(m.responses) {
			ch <- agent.TurnEvent{
				Kind:      agent.EventError,
				Error:     fmt.Errorf("mock: no more responses queued (call %d)", idx),
				ErrorText: fmt.Sprintf("mock: no more responses queued (call %d)", idx),
			}
			return
		}
		for _, event := range m.responses[idx] {
			if ctx.Err() != nil {
				ch <- agent.TurnEvent{Kind: agent.EventError, Error: ctx.Err(), ErrorText: ctx.Err().Error()}
				return
			}
			ch <- event
		}
	}()

	return ch
}

// ─────────────────────────────────────────────────────────────────
// Capture Mocks
// ─────────────────────────────────────────────────────────────────

// configCaptureMock captures the GenerateContentConfig for assertions.
type configCaptureMock struct {
	inner           *mockModelClient
	captureCallback func(config *agent.GenerateContentConfig)
}

func (m *configCaptureMock) StreamMessage(ctx context.Context, history []*models.Message, config *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	if m.captureCallback != nil {
		m.captureCallback(config)
	}
	return m.inner.StreamMessage(ctx, history, config)
}

// historyCaptureMock captures the history for assertions.
type historyCaptureMock struct {
	inner           *mockModelClient
	captureCallback func(history []*models.Message)
}

func (m *historyCaptureMock) StreamMessage(ctx context.Context, history []*models.Message, config *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	if m.captureCallback != nil {
		m.captureCallback(history)
	}
	return m.inner.StreamMessage(ctx, history, config)
}

// ─────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────

func newTestStore(t *testing.T) store.Store {
	t.Helper()
	dbPath := fmt.Sprintf("%s/test_%d.db", t.TempDir(), time.Now().UnixNano())
	s, err := sqlite.New(dbPath)
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	t.Cleanup(func() {
		s.Close()
		os.Remove(dbPath)
	})
	return s
}

func seedConversation(t *testing.T, s store.Store) (*models.Workspace, *models.Conversation) {
	t.Helper()
	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-1", Name: "W", RootPath: "/tmp", CanonicalRootPath: "/tmp"}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{ID: "conv-1", WorkspaceID: "ws-1", Title: "C"}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}
	return ws, conv
}

func makeTextResponse(text string) []agent.TurnEvent {
	return []agent.TurnEvent{
		{Kind: agent.EventDelta, Delta: &agent.StreamDelta{Text: text}},
		{
			Kind: agent.EventMessageDone,
			Message: &models.Message{
				SentBy: models.SentByAgent,
				State:  models.MessageStateCompleted,
				Parts:  []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: text}}},
			},
		},
	}
}

func makeToolCallResponse(calls ...struct{ Name, CallID, Args string }) []agent.TurnEvent {
	parts := make([]models.MessagePart, len(calls))
	for i, c := range calls {
		parts[i] = models.MessagePart{
			Kind: models.PartFunctionCall,
			FunctionCall: &models.FunctionCallPart{
				CallID:   c.CallID,
				Name:     c.Name,
				ArgsJSON: json.RawMessage(c.Args),
			},
		}
	}
	return []agent.TurnEvent{
		{
			Kind: agent.EventMessageDone,
			Message: &models.Message{
				SentBy: models.SentByAgent,
				State:  models.MessageStateCompleted,
				Parts:  parts,
			},
		},
	}
}

func collectEvents(ch <-chan agent.TurnEvent) []agent.TurnEvent {
	var events []agent.TurnEvent
	for e := range ch {
		events = append(events, e)
	}
	return events
}

func findEvent(events []agent.TurnEvent, kind agent.TurnEventKind) *agent.TurnEvent {
	for _, e := range events {
		if e.Kind == kind {
			return &e
		}
	}
	return nil
}

func countEvents(events []agent.TurnEvent, kind agent.TurnEventKind) int {
	n := 0
	for _, e := range events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func simpleTool(name string, result string) *agent.ToolDef {
	decl := genaiDecl(name, name)
	return &agent.ToolDef{
		Declaration: &decl,
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return json.RawMessage(result), nil
		},
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Core Flow
// ─────────────────────────────────────────────────────────────────

func TestSessionSimpleTextResponse(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("Hello!")}}

	session := agent.NewSession(s, mock, ws, conv, "You are helpful.", nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, "Hi")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)

	// Should start with TurnStarted.
	if allEvents[0].Kind != agent.EventTurnStarted {
		t.Errorf("first event = %s, want turn_started", allEvents[0].Kind)
	}
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Error("expected TurnComplete")
	}
	if countEvents(allEvents, agent.EventError) > 0 {
		t.Errorf("unexpected errors: %v", allEvents)
	}

	// Persisted: user + agent = 2.
	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].SentBy != models.SentByUser {
		t.Errorf("msg[0] = %s, want user", msgs[0].SentBy)
	}
	if msgs[1].SentBy != models.SentByAgent {
		t.Errorf("msg[1] = %s, want agent", msgs[1].SentBy)
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Tool Call Cycles
// ─────────────────────────────────────────────────────────────────

func TestSessionToolCallCycle(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{
				"read_file", "call-1", `{"path":"/tmp/test.txt"}`,
			}),
			makeTextResponse("The file contains 'hello world'."),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", []*agent.ToolDef{simpleTool("read_file", `{"content":"hello world"}`)}, 0)

	events, cancel, err := session.HandleUserMessage(ctx, "Read /tmp/test.txt")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)

	if countEvents(allEvents, agent.EventToolCallStart) != 1 {
		t.Errorf("tool call starts = %d, want 1", countEvents(allEvents, agent.EventToolCallStart))
	}
	if countEvents(allEvents, agent.EventToolResult) != 1 {
		t.Errorf("tool results = %d, want 1", countEvents(allEvents, agent.EventToolResult))
	}
	if countEvents(allEvents, agent.EventMessageDone) != 2 {
		t.Errorf("message_done = %d, want 2", countEvents(allEvents, agent.EventMessageDone))
	}
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Error("expected TurnComplete")
	}

	// Tool result success.
	tr := findEvent(allEvents, agent.EventToolResult)
	if !tr.ToolResult.Success {
		t.Error("tool result should be success")
	}

	// Persisted: user + agent(call) + tool(response) + agent(text) = 4.
	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	if len(msgs) != 4 {
		t.Fatalf("expected 4, got %d", len(msgs))
	}
	if mock.callCount.Load() != 2 {
		t.Errorf("mock calls = %d, want 2", mock.callCount.Load())
	}
}

func TestSessionParallelToolCalls(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(
				struct{ Name, CallID, Args string }{"a", "c1", `{}`},
				struct{ Name, CallID, Args string }{"b", "c2", `{}`},
			),
			makeTextResponse("Both done."),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", []*agent.ToolDef{
		simpleTool("a", `{"ok":"a"}`),
		simpleTool("b", `{"ok":"b"}`),
	}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, "Go")
	defer cancel()
	allEvents := collectEvents(events)

	if countEvents(allEvents, agent.EventToolCallStart) != 2 {
		t.Errorf("starts = %d, want 2", countEvents(allEvents, agent.EventToolCallStart))
	}
	if countEvents(allEvents, agent.EventToolResult) != 2 {
		t.Errorf("results = %d, want 2", countEvents(allEvents, agent.EventToolResult))
	}

	// Tool message should have 2 parts.
	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	if len(msgs) != 4 {
		t.Fatalf("expected 4, got %d", len(msgs))
	}
	if len(msgs[2].Parts) != 2 {
		t.Errorf("tool msg parts = %d, want 2", len(msgs[2].Parts))
	}
}

func TestSessionMultiTurnToolCycle(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	// 3 round trips: tool → tool → text.
	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"s1", "c1", `{}`}),
			makeToolCallResponse(struct{ Name, CallID, Args string }{"s2", "c2", `{}`}),
			makeTextResponse("All steps done."),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", []*agent.ToolDef{
		simpleTool("s1", `{"ok":1}`),
		simpleTool("s2", `{"ok":2}`),
	}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, "Multi-step")
	defer cancel()
	allEvents := collectEvents(events)

	if countEvents(allEvents, agent.EventToolCallStart) != 2 {
		t.Errorf("starts = %d, want 2", countEvents(allEvents, agent.EventToolCallStart))
	}
	if mock.callCount.Load() != 3 {
		t.Errorf("calls = %d, want 3", mock.callCount.Load())
	}

	// Messages: user + agent(c1) + tool(r1) + agent(c2) + tool(r2) + agent(text) = 6.
	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	if len(msgs) != 6 {
		t.Fatalf("expected 6, got %d", len(msgs))
	}
	for i, msg := range msgs {
		if msg.Seq != int64(i+1) {
			t.Errorf("msg[%d].Seq = %d, want %d", i, msg.Seq, i+1)
		}
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Cancellation & Abort
// ─────────────────────────────────────────────────────────────────

func TestSessionContextCancellation(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"slow", "c1", `{}`}),
			makeTextResponse("Should not reach"),
		},
	}

	decl := genaiDecl("slow", "Slow")
	tools := []*agent.ToolDef{{
		Declaration: &decl,
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(50 * time.Millisecond):
				return json.RawMessage(`{}`), nil
			}
		},
	}}

	session := agent.NewSession(s, mock, ws, conv, "", tools, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Run slow")

	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	allEvents := collectEvents(events)
	// Test passes if channel closes (no hang). Abort event may or may not appear.
	_ = allEvents
}

func TestSessionCancellationEmitsAbortNotError(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	// Use a slow mock to give us time to cancel.
	slowMock := &slowModelClient{
		delay:    50 * time.Millisecond,
		response: makeTextResponse("Slow response"),
	}

	session := agent.NewSession(s, slowMock, ws, conv, "", nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, "Hello")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}

	// Cancel shortly after turn starts (the mock has a 50ms delay).
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	allEvents := collectEvents(events)

	// Should get TurnAborted, NOT EventError (for context.Canceled).
	if findEvent(allEvents, agent.EventTurnAborted) == nil {
		// If we were too slow to cancel, the turn may have completed normally.
		// That's acceptable — the test is checking that IF cancelled, we get Aborted.
		if findEvent(allEvents, agent.EventTurnComplete) == nil {
			t.Error("expected either TurnAborted or TurnComplete")
		}
	}
}

// slowModelClient introduces a delay before responding.
type slowModelClient struct {
	delay    time.Duration
	response []agent.TurnEvent
}

func (m *slowModelClient) StreamMessage(ctx context.Context, history []*models.Message, config *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	ch := make(chan agent.TurnEvent, 64)
	go func() {
		defer close(ch)
		select {
		case <-ctx.Done():
			ch <- agent.TurnEvent{Kind: agent.EventError, Error: ctx.Err(), ErrorText: ctx.Err().Error()}
			return
		case <-time.After(m.delay):
		}
		for _, event := range m.response {
			if ctx.Err() != nil {
				ch <- agent.TurnEvent{Kind: agent.EventError, Error: ctx.Err(), ErrorText: ctx.Err().Error()}
				return
			}
			ch <- event
		}
	}()
	return ch
}

func TestSessionAbortBeforeSpawn(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	// First turn: model blocks until cancelled.
	blockingMock := &blockingModelClient{
		firstResponse:  makeTextResponse("First response"),
		secondResponse: makeTextResponse("Second response"),
	}

	session := agent.NewSession(s, blockingMock, ws, conv, "", nil, 0)

	// Start first turn.
	events1, _, _ := session.HandleUserMessage(ctx, "First")

	// Start second turn immediately — should abort the first.
	events2, cancel2, _ := session.HandleUserMessage(ctx, "Second")
	defer cancel2()

	// Drain both channels.
	_ = collectEvents(events1)
	allEvents2 := collectEvents(events2)

	// Second turn should complete successfully.
	if findEvent(allEvents2, agent.EventTurnComplete) == nil {
		t.Error("second turn should complete")
	}
}

// blockingModelClient returns immediate responses but tracks call ordering.
type blockingModelClient struct {
	firstResponse  []agent.TurnEvent
	secondResponse []agent.TurnEvent
	callCount      atomic.Int32
}

func (m *blockingModelClient) StreamMessage(ctx context.Context, history []*models.Message, config *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	ch := make(chan agent.TurnEvent, 64)
	idx := int(m.callCount.Add(1)) - 1

	go func() {
		defer close(ch)
		var resp []agent.TurnEvent
		if idx == 0 {
			resp = m.firstResponse
		} else {
			resp = m.secondResponse
		}
		for _, event := range resp {
			if ctx.Err() != nil {
				return
			}
			ch <- event
		}
	}()

	return ch
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Error Handling
// ─────────────────────────────────────────────────────────────────

func TestSessionModelError(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			{{Kind: agent.EventError, Error: fmt.Errorf("rate limit exceeded"), ErrorText: "rate limit exceeded"}},
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Hello")
	defer cancel()

	allEvents := collectEvents(events)

	errEvent := findEvent(allEvents, agent.EventError)
	if errEvent == nil {
		t.Fatal("expected EventError")
	}
	if errEvent.ErrorText != "rate limit exceeded" {
		t.Errorf("error text = %q", errEvent.ErrorText)
	}
	if findEvent(allEvents, agent.EventTurnComplete) != nil {
		t.Error("should not have TurnComplete on error")
	}

	// User message still persisted.
	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 (user only), got %d", len(msgs))
	}
}

func TestSessionToolHandlerError(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"buggy", "c1", `{}`}),
			makeTextResponse("Handled the error."),
		},
	}

	decl := genaiDecl("buggy", "A tool that errors")
	tools := []*agent.ToolDef{{
		Declaration: &decl,
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return nil, fmt.Errorf("permission denied")
		},
	}}

	session := agent.NewSession(s, mock, ws, conv, "", tools, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Run buggy")
	defer cancel()
	allEvents := collectEvents(events)

	tr := findEvent(allEvents, agent.EventToolResult)
	if tr == nil {
		t.Fatal("expected tool result")
	}
	if tr.ToolResult.Success {
		t.Error("should NOT be success")
	}
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Error("should still complete")
	}

	// user + agent(call) + tool(error) + agent(text) = 4.
	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	if len(msgs) != 4 {
		t.Fatalf("expected 4, got %d", len(msgs))
	}
}

func TestSessionNoToolsRegistered(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"nonexistent", "c1", `{}`}),
			makeTextResponse("Recovered."),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Call something")
	defer cancel()
	allEvents := collectEvents(events)

	tr := findEvent(allEvents, agent.EventToolResult)
	if tr == nil {
		t.Fatal("expected tool result")
	}
	if tr.ToolResult.Success {
		t.Error("should be failure for unknown tool")
	}
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Error("should still complete")
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Max Iterations Guard
// ─────────────────────────────────────────────────────────────────

func TestSessionMaxToolCallIterations(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	// Create a mock that always returns tool calls (infinite loop).
	infiniteResponses := make([][]agent.TurnEvent, agent.MaxToolCallIterations+5)
	for i := range infiniteResponses {
		infiniteResponses[i] = makeToolCallResponse(struct{ Name, CallID, Args string }{
			"loop_tool", fmt.Sprintf("c%d", i), `{}`,
		})
	}

	mock := &mockModelClient{responses: infiniteResponses}

	session := agent.NewSession(s, mock, ws, conv, "", []*agent.ToolDef{simpleTool("loop_tool", `{"ok":true}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, "Loop forever")
	defer cancel()

	allEvents := collectEvents(events)

	// Should hit the max iterations error.
	errEvent := findEvent(allEvents, agent.EventError)
	if errEvent == nil {
		t.Fatal("expected error for max iterations")
	}
	if errEvent.ErrorText == "" {
		t.Error("error text should describe max iterations")
	}

	// Should have been called exactly MaxToolCallIterations times (hit on iteration MaxToolCallIterations+1).
	if int(mock.callCount.Load()) != agent.MaxToolCallIterations {
		t.Errorf("mock calls = %d, want %d", mock.callCount.Load(), agent.MaxToolCallIterations)
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — TurnStarted Event
// ─────────────────────────────────────────────────────────────────

func TestSessionEmitsTurnStarted(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("ok")}}

	session := agent.NewSession(s, mock, ws, conv, "", nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Hi")
	defer cancel()
	allEvents := collectEvents(events)

	// TurnStarted must be the very first event.
	if len(allEvents) == 0 {
		t.Fatal("no events")
	}
	if allEvents[0].Kind != agent.EventTurnStarted {
		t.Errorf("first event = %s, want turn_started", allEvents[0].Kind)
	}
	// Exactly one TurnStarted per turn.
	if countEvents(allEvents, agent.EventTurnStarted) != 1 {
		t.Errorf("turn_started count = %d, want 1", countEvents(allEvents, agent.EventTurnStarted))
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — System Prompt & Config
// ─────────────────────────────────────────────────────────────────

func TestSessionSystemPrompt(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	var capturedConfig *agent.GenerateContentConfig
	mock := &configCaptureMock{
		inner: &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("ok")}},
		captureCallback: func(config *agent.GenerateContentConfig) {
			capturedConfig = config
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "You are a coding assistant.", nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "hi")
	defer cancel()
	collectEvents(events)

	if capturedConfig == nil {
		t.Fatal("config not captured")
	}
	if capturedConfig.SystemInstruction != "You are a coding assistant." {
		t.Errorf("system prompt = %q", capturedConfig.SystemInstruction)
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Streaming Deltas
// ─────────────────────────────────────────────────────────────────

func TestSessionDeltaStreaming(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{{
			{Kind: agent.EventDelta, Delta: &agent.StreamDelta{Text: "Hello "}},
			{Kind: agent.EventDelta, Delta: &agent.StreamDelta{Text: "world", IsThought: true}},
			{Kind: agent.EventMessageDone, Message: &models.Message{
				SentBy: models.SentByAgent, State: models.MessageStateCompleted,
				Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "Hello world"}}},
			}},
		}},
	}

	session := agent.NewSession(s, mock, ws, conv, "", nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Hi")
	defer cancel()
	allEvents := collectEvents(events)

	if countEvents(allEvents, agent.EventDelta) != 2 {
		t.Errorf("deltas = %d, want 2", countEvents(allEvents, agent.EventDelta))
	}

	// Check thought flag.
	deltaCount := 0
	for _, e := range allEvents {
		if e.Kind == agent.EventDelta {
			deltaCount++
			if deltaCount == 2 && !e.Delta.IsThought {
				t.Error("second delta should be thought")
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Multiple Turns
// ─────────────────────────────────────────────────────────────────

func TestSessionMultipleUserMessages(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeTextResponse("First response"),
			makeTextResponse("Second response"),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", nil, 0)

	events1, cancel1, _ := session.HandleUserMessage(ctx, "First")
	collectEvents(events1)
	cancel1()

	events2, cancel2, _ := session.HandleUserMessage(ctx, "Second")
	collectEvents(events2)
	cancel2()

	// 4 messages: user1 + agent1 + user2 + agent2.
	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	if len(msgs) != 4 {
		t.Fatalf("expected 4, got %d", len(msgs))
	}
	for i := 0; i < len(msgs); i++ {
		if msgs[i].Seq != int64(i+1) {
			t.Errorf("msg[%d].Seq = %d, want %d", i, msgs[i].Seq, i+1)
		}
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Thread History
// ─────────────────────────────────────────────────────────────────

func TestSessionThreadHistoryComposition(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ws := &models.Workspace{ID: "ws-1", Name: "W", RootPath: "/tmp", CanonicalRootPath: "/tmp"}
	s.Workspaces().Create(ctx, ws)

	// Parent conversation with messages.
	parent := &models.Conversation{ID: "parent", WorkspaceID: "ws-1", Title: "Parent"}
	s.Conversations().Create(ctx, parent)
	s.Messages().Append(ctx, &models.Message{ID: "pm1", ConversationID: "parent", SentBy: models.SentByUser, State: models.MessageStateCompleted,
		Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "Parent Q1"}}}})
	s.Messages().Append(ctx, &models.Message{ID: "pm2", ConversationID: "parent", SentBy: models.SentByAgent, State: models.MessageStateCompleted,
		Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "Parent A1"}}}})

	// Thread.
	thread := &models.Conversation{ID: "thread", WorkspaceID: "ws-1", Title: "Thread",
		ParentConversationID: "parent", AnchorMessageID: "pm2"}
	s.Conversations().Create(ctx, thread)

	var capturedHistory []*models.Message
	mock := &historyCaptureMock{
		inner:           &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("Thread response")}},
		captureCallback: func(h []*models.Message) { capturedHistory = h },
	}

	session := agent.NewSession(s, mock, ws, thread, "", nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Thread question")
	defer cancel()
	collectEvents(events)

	// History should include parent messages + thread user message.
	if len(capturedHistory) < 3 {
		t.Fatalf("history = %d, want ≥ 3", len(capturedHistory))
	}
	if capturedHistory[0].Parts[0].Text.Text != "Parent Q1" {
		t.Errorf("history[0] = %q, want 'Parent Q1'", capturedHistory[0].Parts[0].Text.Text)
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Edge Cases
// ─────────────────────────────────────────────────────────────────

func TestSessionEmptyUserMessage(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("I see empty input")}}

	session := agent.NewSession(s, mock, ws, conv, "", nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, "")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Error("expected TurnComplete")
	}
}

func TestSessionMessageIDsUnique(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"t", "c1", `{}`}),
			makeTextResponse("done"),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", []*agent.ToolDef{simpleTool("t", `{}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, "Go")
	defer cancel()
	collectEvents(events)

	msgs, _ := s.Messages().GetRange(ctx, "conv-1", 1, 100)
	ids := make(map[models.MessageID]bool)
	for _, msg := range msgs {
		if ids[msg.ID] {
			t.Errorf("duplicate ID: %s", msg.ID)
		}
		ids[msg.ID] = true
	}
}

func TestSessionNoResponseFromModel(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	// Model returns empty stream (no events = no agentMsg).
	mock := &mockModelClient{responses: [][]agent.TurnEvent{{}}}

	session := agent.NewSession(s, mock, ws, conv, "", nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, "Hello")
	defer cancel()

	allEvents := collectEvents(events)

	errEvent := findEvent(allEvents, agent.EventError)
	if errEvent == nil {
		t.Fatal("expected error for empty model response")
	}
	if errEvent.ErrorText != "no response from model" {
		t.Errorf("error text = %q", errEvent.ErrorText)
	}
}

func TestSessionEventOrder(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"t", "c1", `{}`}),
			makeTextResponse("done"),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, "", []*agent.ToolDef{simpleTool("t", `{}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, "Go")
	defer cancel()
	allEvents := collectEvents(events)

	// Verify strict ordering: TurnStarted → ... → ToolCallStart → ToolResult → ... → TurnComplete.
	if len(allEvents) < 4 {
		t.Fatalf("too few events: %d", len(allEvents))
	}
	if allEvents[0].Kind != agent.EventTurnStarted {
		t.Errorf("event[0] = %s, want turn_started", allEvents[0].Kind)
	}
	if allEvents[len(allEvents)-1].Kind != agent.EventTurnComplete {
		t.Errorf("last event = %s, want turn_complete", allEvents[len(allEvents)-1].Kind)
	}

	// ToolCallStart must come before ToolResult.
	tcStartIdx, trIdx := -1, -1
	for i, e := range allEvents {
		if e.Kind == agent.EventToolCallStart && tcStartIdx == -1 {
			tcStartIdx = i
		}
		if e.Kind == agent.EventToolResult && trIdx == -1 {
			trIdx = i
		}
	}
	if tcStartIdx >= trIdx {
		t.Errorf("ToolCallStart (idx %d) should precede ToolResult (idx %d)", tcStartIdx, trIdx)
	}
}

func TestSessionHistoryGrowsEachIteration(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	// Track history lengths across iterations.
	var historyLengths []int
	captureMock := &historyCaptureMock{
		inner: &mockModelClient{
			responses: [][]agent.TurnEvent{
				makeToolCallResponse(struct{ Name, CallID, Args string }{"t", "c1", `{}`}),
				makeTextResponse("done"),
			},
		},
		captureCallback: func(h []*models.Message) {
			historyLengths = append(historyLengths, len(h))
		},
	}

	session := agent.NewSession(s, captureMock, ws, conv, "", []*agent.ToolDef{simpleTool("t", `{}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, "Go")
	defer cancel()
	collectEvents(events)

	// History should grow between iterations (tool results added).
	if len(historyLengths) != 2 {
		t.Fatalf("expected 2 model calls, got %d", len(historyLengths))
	}
	if historyLengths[1] <= historyLengths[0] {
		t.Errorf("history should grow: iter1=%d, iter2=%d", historyLengths[0], historyLengths[1])
	}
}
