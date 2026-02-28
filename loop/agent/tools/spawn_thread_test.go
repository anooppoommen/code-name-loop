package tools_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"loop/agent"
	"loop/agent/tools"
	"loop/models"
	"loop/store"
	"loop/store/sqlite"
)

// ─────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────

func newThreadTestStore(t *testing.T) store.Store {
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

func seedWorkspaceAndConv(t *testing.T, s store.Store) (*models.Workspace, *models.Conversation) {
	t.Helper()
	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-1", RootPath: "/tmp", CanonicalRootPath: "/tmp"}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{ID: "conv-root", WorkspaceID: ws.ID, Title: "Root"}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}
	return ws, conv
}

// mockClient returns canned responses for tests.
type mockClientForSpawn struct {
	responses [][]agent.TurnEvent
	callCount int
}

func (m *mockClientForSpawn) StreamMessage(ctx context.Context, history []*models.Message, config *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	ch := make(chan agent.TurnEvent, 64)
	idx := m.callCount
	m.callCount++
	go func() {
		defer close(ch)
		if idx >= len(m.responses) {
			ch <- agent.TurnEvent{Kind: agent.EventError, ErrorText: fmt.Sprintf("mock: no response queued (call %d)", idx)}
			return
		}
		for _, ev := range m.responses[idx] {
			if ctx.Err() != nil {
				return
			}
			ch <- ev
		}
	}()
	return ch
}

func makeTextEvent(text string) []agent.TurnEvent {
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
		{Kind: agent.EventTurnComplete},
	}
}

func unmarshalSpawnResult(t *testing.T, raw json.RawMessage) map[string]string {
	t.Helper()
	var r map[string]string
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatalf("unmarshal spawn result: %v (raw=%s)", err, raw)
	}
	return r
}

// ─────────────────────────────────────────────────────────────────
// spawn_thread Tests
// ─────────────────────────────────────────────────────────────────

func TestSpawnThreadBlocking_CompletesWithResult(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	// Seed a user message so parent conv has a HeadMessageID to anchor to.
	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	if err := s.Messages().Append(ctx, parentMsg); err != nil {
		t.Fatalf("append parent msg: %v", err)
	}
	// Refresh conv.HeadMessageID from DB.
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	client := &mockClientForSpawn{responses: [][]agent.TurnEvent{makeTextEvent("child answer")}}

	tool := tools.NewSpawnThreadTool(s, client, ws, conv, nil, 0)
	args, _ := json.Marshal(map[string]string{
		"title":            "sub-task",
		"task":             "do something",
		"context_strategy": "summary",
		"mode":             "blocking",
	})

	result, err := tool.Handler(ctx, args)
	if err != nil {
		t.Fatalf("unexpected handler error: %v", err)
	}

	r := unmarshalSpawnResult(t, result)
	if r["status"] != "completed" {
		t.Errorf("status = %q, want completed (full result JSON: %s)", r["status"], result)
	}
	if r["result"] != "child answer" {
		t.Errorf("result = %q, want 'child answer'", r["result"])
	}
	if r["thread_id"] == "" {
		t.Error("thread_id should be non-empty")
	}

	// Verify persisted in DB.
	childConv, err := s.Conversations().Get(ctx, models.ConversationID(r["thread_id"]))
	if err != nil {
		t.Fatalf("get child conv: %v", err)
	}
	if childConv.ThreadStatus != models.ThreadStatusCompleted {
		t.Errorf("db status = %q, want completed", childConv.ThreadStatus)
	}
	if childConv.ResultMessage != "child answer" {
		t.Errorf("db result = %q, want 'child answer'", childConv.ResultMessage)
	}
}

func TestSpawnThreadAsync_ReturnsImmediately(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	s.Messages().Append(ctx, parentMsg)
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	// Slow client — should not block the tool call.
	slowClient := &slowSpawnClient{delay: 200 * time.Millisecond, text: "async answer"}

	tool := tools.NewSpawnThreadTool(s, slowClient, ws, conv, nil, 0)
	args, _ := json.Marshal(map[string]string{
		"title":            "async-task",
		"task":             "run slowly",
		"context_strategy": "summary",
		"mode":             "async",
	})

	start := time.Now()
	result, _ := tool.Handler(ctx, args)
	elapsed := time.Since(start)

	if elapsed > 100*time.Millisecond {
		t.Errorf("async spawn took %v, want < 100ms", elapsed)
	}

	r := unmarshalSpawnResult(t, result)
	if r["status"] != "running" {
		t.Errorf("status = %q, want running", r["status"])
	}
	if r["thread_id"] == "" {
		t.Error("thread_id should be non-empty")
	}
}

func TestSpawnThreadAsync_BackgroundWritesResult(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	s.Messages().Append(ctx, parentMsg)
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	client := &slowSpawnClient{delay: 50 * time.Millisecond, text: "background result"}

	tool := tools.NewSpawnThreadTool(s, client, ws, conv, nil, 0)
	args, _ := json.Marshal(map[string]string{
		"title": "bg", "task": "go do it", "context_strategy": "summary", "mode": "async",
	})

	result, _ := tool.Handler(ctx, args)
	r := unmarshalSpawnResult(t, result)
	threadID := models.ConversationID(r["thread_id"])

	// Wait for background goroutine to settle.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		child, _ := s.Conversations().Get(ctx, threadID)
		if child != nil && child.ThreadStatus == models.ThreadStatusCompleted {
			if child.ResultMessage != "background result" {
				t.Errorf("result = %q, want 'background result'", child.ResultMessage)
			}
			return // pass
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Error("async thread never reached completed status")
}

func TestSpawnThreadDepthGuard(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	// Depth == MaxThreadDepth: should be rejected.
	tool := tools.NewSpawnThreadTool(s, nil, ws, conv, nil, tools.MaxThreadDepth)
	args, _ := json.Marshal(map[string]string{
		"title": "deep", "task": "x", "context_strategy": "full_chain", "mode": "blocking",
	})
	result, _ := tool.Handler(ctx, args)

	var r map[string]string
	json.Unmarshal(result, &r)
	if r["error"] == "" {
		t.Errorf("expected depth guard error, got: %s", result)
	}
}

func TestSpawnThreadParallelBlocking_NThreads(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	s.Messages().Append(ctx, parentMsg)
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	makeToolForAnswer := func(answer string) *agent.ToolDef {
		cl := &mockClientForSpawn{responses: [][]agent.TurnEvent{makeTextEvent(answer)}}
		return tools.NewSpawnThreadTool(s, cl, ws, conv, nil, 0)
	}

	type call struct {
		tool *agent.ToolDef
		args json.RawMessage
		res  json.RawMessage
	}
	n := 3
	calls := make([]call, n)
	for i := 0; i < n; i++ {
		answer := fmt.Sprintf("answer-%d", i)
		a, _ := json.Marshal(map[string]string{
			"title": fmt.Sprintf("t%d", i), "task": "go", "context_strategy": "summary", "mode": "blocking",
		})
		calls[i] = call{tool: makeToolForAnswer(answer), args: a}
	}

	// Simulate ExecuteToolCalls' concurrent dispatch.
	done := make(chan int, n)
	for i, c := range calls {
		i, c := i, c
		go func() {
			res, _ := c.tool.Handler(ctx, c.args)
			calls[i].res = res
			done <- i
		}()
	}

	for i := 0; i < n; i++ {
		<-done
	}

	for i, c := range calls {
		r := unmarshalSpawnResult(t, c.res)
		if r["status"] != "completed" {
			t.Errorf("call[%d] status = %q, want completed", i, r["status"])
		}
		wantResult := fmt.Sprintf("answer-%d", i)
		if r["result"] != wantResult {
			t.Errorf("call[%d] result = %q, want %q", i, r["result"], wantResult)
		}
	}
}

func TestSpawnThreadChildToolError_DoesNotCrashParent(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	s.Messages().Append(ctx, parentMsg)
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	// Model returns an error event.
	errClient := &mockClientForSpawn{responses: [][]agent.TurnEvent{
		{{Kind: agent.EventError, ErrorText: "model exploded"}},
	}}

	tool := tools.NewSpawnThreadTool(s, errClient, ws, conv, nil, 0)
	args, _ := json.Marshal(map[string]string{
		"title": "err", "task": "crash", "context_strategy": "summary", "mode": "blocking",
	})

	// Should not panic, should return failed status.
	result, err := tool.Handler(ctx, args)
	if err != nil {
		t.Fatalf("tool.Handler panicked or errored: %v", err)
	}

	r := unmarshalSpawnResult(t, result)
	if r["status"] != "failed" {
		t.Errorf("status = %q, want failed", r["status"])
	}
	if r["error"] == "" && r["result"] == "" {
		t.Error("expected non-empty error or result for failed thread")
	}
}

func TestSpawnThreadCancellation_PropagatedToChild(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	s.Messages().Append(ctx, parentMsg)
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	// Very slow client — will be cancelled mid-way.
	slowCl := &slowSpawnClient{delay: 500 * time.Millisecond, text: "never"}
	tool := tools.NewSpawnThreadTool(s, slowCl, ws, conv, nil, 0)
	args, _ := json.Marshal(map[string]string{
		"title": "cancel", "task": "go slow", "context_strategy": "summary", "mode": "blocking",
	})

	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()

	result, _ := tool.Handler(ctx, args)
	r := unmarshalSpawnResult(t, result)
	// Cancellation should result in a failed or empty-result thread (not hang).
	if r["status"] == "" {
		t.Errorf("expected a status, got: %s", result)
	}
}

func TestSpawnThreadNestedDepth1CanSpawnDepth2(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	s.Messages().Append(ctx, parentMsg)
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	// depth=1 should succeed (< MaxThreadDepth=2).
	client := &mockClientForSpawn{responses: [][]agent.TurnEvent{makeTextEvent("grandchild done")}}
	tool := tools.NewSpawnThreadTool(s, client, ws, conv, nil, 1)
	args, _ := json.Marshal(map[string]string{
		"title": "grandchild", "task": "deep task", "context_strategy": "summary", "mode": "blocking",
	})

	result, _ := tool.Handler(ctx, args)
	r := unmarshalSpawnResult(t, result)
	if r["status"] != "completed" {
		t.Errorf("depth=1 spawn should succeed, got status=%q (full: %s)", r["status"], result)
	}
}

// ─────────────────────────────────────────────────────────────────
// await_thread Tests
// ─────────────────────────────────────────────────────────────────

func TestAwaitThreadPoll_ReturnsCurrentStatus(t *testing.T) {
	s := newThreadTestStore(t)
	ws, _ := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	// Create a running thread directly.
	thread := &models.Conversation{
		ID:           "thread-1",
		WorkspaceID:  ws.ID,
		ThreadStatus: models.ThreadStatusRunning,
	}
	if err := s.Conversations().Create(ctx, thread); err != nil {
		t.Fatalf("create thread: %v", err)
	}

	tool := tools.NewAwaitThreadTool(s)
	args, _ := json.Marshal(map[string]interface{}{
		"thread_id": "thread-1",
		"blocking":  false,
	})
	result, _ := tool.Handler(ctx, args)

	var r map[string]string
	json.Unmarshal(result, &r)
	if r["status"] != string(models.ThreadStatusRunning) {
		t.Errorf("status = %q, want running", r["status"])
	}
}

func TestAwaitThreadBlocking_WaitsForCompletion(t *testing.T) {
	s := newThreadTestStore(t)
	ws, _ := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	thread := &models.Conversation{
		ID:           "thread-2",
		WorkspaceID:  ws.ID,
		ThreadStatus: models.ThreadStatusRunning,
	}
	s.Conversations().Create(ctx, thread)

	// Simulate the async goroutine completing after 80ms.
	go func() {
		time.Sleep(80 * time.Millisecond)
		thread.ThreadStatus = models.ThreadStatusCompleted
		thread.ResultMessage = "ready"
		s.Conversations().Update(context.Background(), thread)
	}()

	tool := tools.NewAwaitThreadTool(s)
	args, _ := json.Marshal(map[string]interface{}{
		"thread_id": "thread-2",
		"blocking":  true,
	})

	start := time.Now()
	result, _ := tool.Handler(ctx, args)
	elapsed := time.Since(start)

	if elapsed < 70*time.Millisecond {
		t.Errorf("should have waited at least 70ms, waited %v", elapsed)
	}

	var r map[string]string
	json.Unmarshal(result, &r)
	if r["status"] != "completed" {
		t.Errorf("status = %q, want completed", r["status"])
	}
	if r["result"] != "ready" {
		t.Errorf("result = %q, want 'ready'", r["result"])
	}
}

func TestAwaitThreadUnknownID_ReturnsError(t *testing.T) {
	s := newThreadTestStore(t)
	_, _ = seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	tool := tools.NewAwaitThreadTool(s)
	args, _ := json.Marshal(map[string]interface{}{
		"thread_id": "does-not-exist",
		"blocking":  false,
	})
	result, _ := tool.Handler(ctx, args)

	var r map[string]string
	json.Unmarshal(result, &r)
	if r["error"] == "" {
		t.Errorf("expected error for unknown thread_id, got: %s", result)
	}
}

func TestAwaitThreadContextCancelled_StopsWaiting(t *testing.T) {
	s := newThreadTestStore(t)
	ws, _ := seedWorkspaceAndConv(t, s)
	ctx, cancel := context.WithCancel(context.Background())

	thread := &models.Conversation{
		ID: "thread-3", WorkspaceID: ws.ID, ThreadStatus: models.ThreadStatusRunning,
	}
	s.Conversations().Create(ctx, thread)

	go func() {
		time.Sleep(40 * time.Millisecond)
		cancel()
	}()

	tool := tools.NewAwaitThreadTool(s)
	args, _ := json.Marshal(map[string]interface{}{"thread_id": "thread-3", "blocking": true})

	start := time.Now()
	result, _ := tool.Handler(ctx, args)
	elapsed := time.Since(start)

	if elapsed > 300*time.Millisecond {
		t.Errorf("await should have been cancelled quickly, took %v", elapsed)
	}
	var r map[string]string
	json.Unmarshal(result, &r)
	if r["error"] == "" {
		t.Errorf("expected cancellation error, got: %s", result)
	}
}

// ─────────────────────────────────────────────────────────────────
// Integration: parent does work, then awaits async child
// ─────────────────────────────────────────────────────────────────

func TestIntegration_ParentSpawnsAsyncThenAwaits(t *testing.T) {
	s := newThreadTestStore(t)
	ws, conv := seedWorkspaceAndConv(t, s)
	ctx := context.Background()

	parentMsg := &models.Message{ID: "msg-1", ConversationID: conv.ID, SentBy: models.SentByUser,
		State: models.MessageStateCompleted, Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}}}}
	s.Messages().Append(ctx, parentMsg)
	conv, _ = s.Conversations().Get(ctx, conv.ID)

	// Async child takes 80ms to complete.
	asyncClient := &slowSpawnClient{delay: 80 * time.Millisecond, text: "async done"}
	spawnTool := tools.NewSpawnThreadTool(s, asyncClient, ws, conv, nil, 0)
	awaitTool := tools.NewAwaitThreadTool(s)

	// 1. Spawn async.
	spawnArgs, _ := json.Marshal(map[string]string{
		"title": "async", "task": "compute", "context_strategy": "summary", "mode": "async",
	})
	spawnResult, _ := spawnTool.Handler(ctx, spawnArgs)
	spawnR := unmarshalSpawnResult(t, spawnResult)

	if spawnR["status"] != "running" {
		t.Fatalf("expected running immediately, got %q", spawnR["status"])
	}
	threadID := spawnR["thread_id"]

	// 2. Simulate parent doing other work (< child completion time).
	time.Sleep(10 * time.Millisecond)

	// 3. Await the child (blocking=true).
	awaitArgs, _ := json.Marshal(map[string]interface{}{"thread_id": threadID, "blocking": true})
	awaitResult, _ := awaitTool.Handler(ctx, awaitArgs)

	var awaitR map[string]string
	json.Unmarshal(awaitResult, &awaitR)
	if awaitR["status"] != "completed" {
		t.Errorf("await status = %q, want completed (full: %s)", awaitR["status"], awaitResult)
	}
	if awaitR["result"] != "async done" {
		t.Errorf("await result = %q, want 'async done'", awaitR["result"])
	}
}

// ─────────────────────────────────────────────────────────────────
// Slow mock client
// ─────────────────────────────────────────────────────────────────

type slowSpawnClient struct {
	delay time.Duration
	text  string
}

func (m *slowSpawnClient) StreamMessage(ctx context.Context, _ []*models.Message, _ *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	ch := make(chan agent.TurnEvent, 8)
	go func() {
		defer close(ch)
		select {
		case <-ctx.Done():
			ch <- agent.TurnEvent{Kind: agent.EventError, ErrorText: ctx.Err().Error()}
			return
		case <-time.After(m.delay):
		}
		for _, ev := range makeTextEvent(m.text) {
			ch <- ev
		}
	}()
	return ch
}
