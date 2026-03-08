package agent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"loop/agent"
	"loop/agent/systeminstruction"
	agenttools "loop/agent/tools"
	"loop/gitcheckpoints"
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
	model     string
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

func (m *mockModelClient) Model() string {
	return strings.TrimSpace(m.model)
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

func statusTexts(events []agent.TurnEvent) []string {
	var out []string
	for _, e := range events {
		if e.Kind == agent.EventStatus && e.Status != nil {
			out = append(out, e.Status.Text)
		}
	}
	return out
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

func textParts(text string) []models.MessagePart {
	return []models.MessagePart{{
		Kind: models.PartText,
		Text: &models.TextPart{Text: text},
	}}
}

func toolResponsePart(callID, name, raw string) []models.MessagePart {
	return []models.MessagePart{{
		Kind: models.PartFunctionResponse,
		FunctionResponse: &models.FunctionResponsePart{
			CallID:       callID,
			Name:         name,
			ResponseJSON: json.RawMessage(raw),
		},
	}}
}

func historyToolResponseMap(t *testing.T, history []*models.Message, callID string) map[string]any {
	t.Helper()
	for _, msg := range history {
		if msg == nil || msg.SentBy != models.SentByTool {
			continue
		}
		for _, part := range msg.Parts {
			if part.Kind != models.PartFunctionResponse || part.FunctionResponse == nil {
				continue
			}
			if part.FunctionResponse.CallID != callID {
				continue
			}
			var parsed map[string]any
			if err := json.Unmarshal(part.FunctionResponse.ResponseJSON, &parsed); err != nil {
				t.Fatalf("unmarshal tool response %s: %v", callID, err)
			}
			return parsed
		}
	}
	t.Fatalf("tool response %s not found in history", callID)
	return nil
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Core Flow
// ─────────────────────────────────────────────────────────────────

func TestSessionSimpleTextResponse(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("Hello!")}}

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, textParts("Hi"))
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

func TestSessionPersistsUserMessageModelAndThinkingLevel(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()
	variant := systeminstruction.DefaultVariant()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{makeTextResponse("done")},
		model:     "gemini-3.1-pro-preview",
	}

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	session.ThinkingLevel = "high"

	events, cancel, err := session.HandleUserMessage(ctx, textParts("persist settings"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()
	_ = collectEvents(events)

	msgs, err := s.Messages().GetRange(ctx, conv.ID, 1, 10)
	if err != nil {
		t.Fatalf("get messages: %v", err)
	}
	if len(msgs) < 1 {
		t.Fatalf("expected at least one message, got %d", len(msgs))
	}

	userMsg := msgs[0]
	if userMsg.SentBy != models.SentByUser {
		t.Fatalf("first message sent_by=%s, want user", userMsg.SentBy)
	}
	if got, _ := userMsg.Metadata["model"].(string); got != "gemini-3.1-pro-preview" {
		t.Fatalf("user metadata model=%q", got)
	}
	if got, _ := userMsg.Metadata["thinking_level"].(string); got != "high" {
		t.Fatalf("user metadata thinking_level=%q", got)
	}
	if got, _ := userMsg.Metadata["system_prompt_id"].(string); got != variant.ID {
		t.Fatalf("user metadata system_prompt_id=%q", got)
	}
	if got, _ := userMsg.Metadata["system_prompt_name"].(string); got != variant.Name {
		t.Fatalf("user metadata system_prompt_name=%q", got)
	}

	agentMsg := msgs[len(msgs)-1]
	if agentMsg.SentBy != models.SentByAgent {
		t.Fatalf("last message sent_by=%s, want agent", agentMsg.SentBy)
	}
	if got, _ := agentMsg.Metadata["system_prompt_id"].(string); got != variant.ID {
		t.Fatalf("agent metadata system_prompt_id=%q", got)
	}

	updatedConv, err := s.Conversations().Get(ctx, conv.ID)
	if err != nil {
		t.Fatalf("get conversation: %v", err)
	}
	if updatedConv.SystemPromptID != variant.ID {
		t.Fatalf("conversation system_prompt_id=%q", updatedConv.SystemPromptID)
	}
	if updatedConv.SystemPromptName != variant.Name {
		t.Fatalf("conversation system_prompt_name=%q", updatedConv.SystemPromptName)
	}
}

func TestSessionCreatesCheckpointForGitWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	s := newTestStore(t)
	ctx := context.Background()
	repo := t.TempDir()
	runGitSessionTest(t, ctx, repo, "init")
	runGitSessionTest(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitSessionTest(t, ctx, repo, "config", "user.email", "loop@example.com")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write tracked: %v", err)
	}
	runGitSessionTest(t, ctx, repo, "add", "tracked.txt")
	runGitSessionTest(t, ctx, repo, "commit", "-m", "initial")

	ws := &models.Workspace{
		ID:                "ws-git",
		Name:              "Git workspace",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	conv := &models.Conversation{
		ID:          "conv-git",
		WorkspaceID: ws.ID,
		Title:       "Git conversation",
	}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	mock := &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("Hello!")}}
	session := agent.NewSession(s, mock, ws, conv, nil, 0)

	events, cancel, err := session.HandleUserMessage(ctx, textParts("Hi"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Fatalf("expected turn_complete, events=%+v", allEvents)
	}

	checkpoints, err := s.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list checkpoints: %v", err)
	}
	if len(checkpoints) != 1 {
		t.Fatalf("expected 1 checkpoint, got %d", len(checkpoints))
	}
	if checkpoints[0].CommitID == "" {
		t.Fatalf("checkpoint missing commit id: %+v", checkpoints[0])
	}

	uiEvents, err := s.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("get ui events: %v", err)
	}
	if len(uiEvents) == 0 {
		t.Fatalf("expected checkpoint ui events")
	}
	found := false
	for _, evt := range uiEvents {
		if evt.Kind != models.UIEventKindCheckpointCreated {
			continue
		}
		found = true
		if evt.MessageID == "" {
			t.Fatalf("checkpoint created event missing message id: %+v", evt)
		}
		if got := fmt.Sprint(evt.Metadata["checkpoint_id"]); got != checkpoints[0].ID {
			t.Fatalf("checkpoint event metadata checkpoint_id = %v, want %s", evt.Metadata["checkpoint_id"], checkpoints[0].ID)
		}
	}
	if !found {
		t.Fatalf("expected checkpoint_created ui event, events=%+v", uiEvents)
	}
}

func TestSessionCheckpointCapturesPreToolWorkspaceState(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	s := newTestStore(t)
	ctx := context.Background()
	repo := t.TempDir()
	runGitSessionTest(t, ctx, repo, "init")
	runGitSessionTest(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitSessionTest(t, ctx, repo, "config", "user.email", "loop@example.com")
	trackedPath := filepath.Join(repo, "tracked.txt")
	if err := os.WriteFile(trackedPath, []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write tracked: %v", err)
	}
	runGitSessionTest(t, ctx, repo, "add", "tracked.txt")
	runGitSessionTest(t, ctx, repo, "commit", "-m", "initial")

	ws := &models.Workspace{
		ID:                "ws-git-pretool",
		Name:              "Git pretool workspace",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-git-pretool",
		WorkspaceID: ws.ID,
		Title:       "Git pretool conversation",
	}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	patchJSON, err := json.Marshal(map[string]string{
		"input": "*** Begin Patch\n*** Update File: tracked.txt\n@@ -1,1 +1,1 @@\n-base\n+changed by tool\n*** End Patch",
	})
	if err != nil {
		t.Fatalf("marshal patch args: %v", err)
	}

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{
				"apply_patch", "call-1", string(patchJSON),
			}),
			makeTextResponse("Patched the file."),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{agenttools.NewApplyPatchTool(ws)}, 0)
	events, cancel, err := session.HandleUserMessage(ctx, textParts("Patch tracked.txt"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Fatalf("expected turn_complete, events=%+v", allEvents)
	}

	checkpoints, err := s.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list checkpoints: %v", err)
	}
	if len(checkpoints) != 1 {
		t.Fatalf("expected 1 checkpoint, got %d", len(checkpoints))
	}

	gotTracked, err := os.ReadFile(trackedPath)
	if err != nil {
		t.Fatalf("read tracked after tool patch: %v", err)
	}
	if string(gotTracked) != "changed by tool\n" {
		t.Fatalf("tracked after tool patch = %q, want %q", string(gotTracked), "changed by tool\n")
	}

	snapshotContent, err := gitcheckpoints.ReadFileAtSnapshot(ctx, repo, &gitcheckpoints.Snapshot{
		CommitID:                  checkpoints[0].CommitID,
		Parent:                    checkpoints[0].ParentCommitID,
		GitRef:                    checkpoints[0].GitRef,
		PreexistingUntrackedFiles: checkpoints[0].PreexistingUntrackedFiles,
		PreexistingUntrackedDirs:  checkpoints[0].PreexistingUntrackedDirs,
	}, "tracked.txt")
	if err != nil {
		t.Fatalf("read tracked from checkpoint snapshot: %v", err)
	}
	if string(snapshotContent) != "base\n" {
		t.Fatalf("tracked content in checkpoint snapshot = %q, want %q", string(snapshotContent), "base\n")
	}
}

func TestSessionCheckpointFailureDoesNotBlockMessage(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	workspaceRoot := fmt.Sprintf("%s/missing-workspace-root", t.TempDir())
	ws := &models.Workspace{
		ID:                "ws-ckpt-fail-open",
		Name:              "Missing workspace",
		RootPath:          workspaceRoot,
		CanonicalRootPath: workspaceRoot,
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	conv := &models.Conversation{
		ID:          "conv-ckpt-fail-open",
		WorkspaceID: ws.ID,
		Title:       "Checkpoint fail-open",
	}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	mock := &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("Hello!")}}
	session := agent.NewSession(s, mock, ws, conv, nil, 0)

	events, cancel, err := session.HandleUserMessage(ctx, textParts("Hi"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Fatalf("expected turn_complete, events=%+v", allEvents)
	}

	msgs, err := s.Messages().GetRange(ctx, conv.ID, 1, 100)
	if err != nil {
		t.Fatalf("get messages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].SentBy != models.SentByUser {
		t.Fatalf("msg[0] = %s, want user", msgs[0].SentBy)
	}
	if msgs[1].SentBy != models.SentByAgent {
		t.Fatalf("msg[1] = %s, want agent", msgs[1].SentBy)
	}
	if msgs[0].Metadata != nil && msgs[0].Metadata["checkpoint_id"] != nil {
		t.Fatalf("expected no checkpoint metadata on user message, got %#v", msgs[0].Metadata)
	}

	checkpoints, err := s.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list checkpoints: %v", err)
	}
	if len(checkpoints) != 0 {
		t.Fatalf("expected no checkpoints, got %d", len(checkpoints))
	}
}

func runGitSessionTest(t *testing.T, ctx context.Context, repo string, args ...string) {
	t.Helper()
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v (%s)", args, err, string(out))
	}
}

func TestSessionRetriesOn503AndEmitsRetryEvents(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			{
				{
					Kind:      agent.EventError,
					Error:     fmt.Errorf("503 Service Unavailable"),
					ErrorText: "503 Service Unavailable",
				},
			},
			makeTextResponse("Recovered after retry."),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	session.MaxModelRetries = 2
	session.RetryDelay = 120 * time.Millisecond
	session.RetryTick = 40 * time.Millisecond

	events, cancel, err := session.HandleUserMessage(ctx, textParts("retry please"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)

	if mock.callCount.Load() != 2 {
		t.Fatalf("model call count = %d, want 2", mock.callCount.Load())
	}
	if countEvents(allEvents, agent.EventRetry) == 0 {
		t.Fatal("expected at least one retry event")
	}
	if findEvent(allEvents, agent.EventTurnComplete) == nil {
		t.Fatal("expected turn_complete after retry")
	}
	if countEvents(allEvents, agent.EventError) > 0 {
		t.Fatalf("unexpected terminal error events: %+v", allEvents)
	}

	var sawRetryStatus bool
	for _, status := range statusTexts(allEvents) {
		if strings.Contains(status, "Service unavailable (503). Retrying in") {
			sawRetryStatus = true
			break
		}
	}
	if !sawRetryStatus {
		t.Fatalf("expected retry status in status events, got: %v", statusTexts(allEvents))
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

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{simpleTool("read_file", `{"content":"hello world"}`)}, 0)

	events, cancel, err := session.HandleUserMessage(ctx, textParts("Read /tmp/test.txt"))
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

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{
		simpleTool("a", `{"ok":"a"}`),
		simpleTool("b", `{"ok":"b"}`),
	}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Go"))
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

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{
		simpleTool("s1", `{"ok":1}`),
		simpleTool("s2", `{"ok":2}`),
	}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Multi-step"))
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

	session := agent.NewSession(s, mock, ws, conv, tools, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Run slow"))

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

	session := agent.NewSession(s, slowMock, ws, conv, nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, textParts("Hello"))
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

func TestSessionCancellationPersistsPartialAgentMessage(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	deltaSent := make(chan struct{})
	mock := &partialStreamingModelClient{
		deltaText: "Partial response",
		deltaSent: deltaSent,
	}

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	session.ThinkingLevel = "medium"

	events, cancel, err := session.HandleUserMessage(ctx, textParts("Hello"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}

	<-deltaSent
	cancel()

	allEvents := collectEvents(events)
	if findEvent(allEvents, agent.EventTurnAborted) == nil {
		t.Fatalf("expected TurnAborted, events=%+v", allEvents)
	}

	msgs, err := s.Messages().GetRange(ctx, conv.ID, 1, 10)
	if err != nil {
		t.Fatalf("get messages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}

	partial := msgs[1]
	if partial.SentBy != models.SentByAgent {
		t.Fatalf("partial sent_by=%s, want agent", partial.SentBy)
	}
	if partial.State != models.MessageStateCanceled {
		t.Fatalf("partial state=%s, want canceled", partial.State)
	}
	if len(partial.Parts) != 1 || partial.Parts[0].Text == nil || partial.Parts[0].Text.Text != "Partial response" {
		t.Fatalf("partial parts=%+v", partial.Parts)
	}
	if got, _ := partial.Metadata["partial"].(bool); !got {
		t.Fatalf("partial metadata partial=%v", partial.Metadata["partial"])
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

type partialStreamingModelClient struct {
	deltaText string
	deltaSent chan struct{}
}

func (m *partialStreamingModelClient) StreamMessage(ctx context.Context, history []*models.Message, config *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	ch := make(chan agent.TurnEvent, 64)
	go func() {
		defer close(ch)
		ch <- agent.TurnEvent{
			Kind:  agent.EventDelta,
			Delta: &agent.StreamDelta{Text: m.deltaText},
		}
		if m.deltaSent != nil {
			close(m.deltaSent)
		}
		<-ctx.Done()
		ch <- agent.TurnEvent{Kind: agent.EventError, Error: ctx.Err(), ErrorText: ctx.Err().Error()}
	}()
	return ch
}

func (m *partialStreamingModelClient) Model() string {
	return "gemini-3.1-pro-preview"
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

	session := agent.NewSession(s, blockingMock, ws, conv, nil, 0)

	// Start first turn.
	events1, _, _ := session.HandleUserMessage(ctx, textParts("First"))

	// Start second turn immediately — should abort the first.
	events2, cancel2, _ := session.HandleUserMessage(ctx, textParts("Second"))
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Hello"))
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

	session := agent.NewSession(s, mock, ws, conv, tools, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Run buggy"))
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Call something"))
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

func TestSessionToolResultTruncationPreservesJSON(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	longOutput := strings.Repeat("x", 5000)
	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"echo", "c1", `{}`}),
			makeTextResponse("done"),
		},
	}

	tools := []*agent.ToolDef{simpleTool("echo", fmt.Sprintf(`{"output":%q,"ok":true}`, longOutput))}
	session := agent.NewSession(s, mock, ws, conv, tools, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("run tool"))
	defer cancel()
	allEvents := collectEvents(events)

	tr := findEvent(allEvents, agent.EventToolResult)
	if tr == nil || tr.ToolResult == nil {
		t.Fatal("expected tool result event")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(tr.ToolResult.Result), &parsed); err != nil {
		t.Fatalf("tool result should remain valid json, got error: %v", err)
	}
	out, ok := parsed["output"].(string)
	if !ok {
		t.Fatal("expected output string in tool result json")
	}
	if !strings.Contains(out, "...(truncated)") {
		t.Fatal("expected output text to be truncated")
	}

	evts, err := s.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("load ui events: %v", err)
	}

	var foundPersisted bool
	for _, evt := range evts {
		if evt.Kind != models.UIEventKindToolResult {
			continue
		}
		raw, ok := evt.Metadata["result"].(string)
		if !ok || raw == "" {
			continue
		}
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			t.Fatalf("persisted tool result should remain valid json, got error: %v", err)
		}
		foundPersisted = true
		break
	}
	if !foundPersisted {
		t.Fatal("expected persisted tool_result ui event with json result")
	}
}

func TestSessionToolCallArgsTruncationPreservesJSON(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	longPath := strings.Repeat("p", 2600)
	args := fmt.Sprintf(`{"path":%q,"mode":"read"}`, longPath)
	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"read_file", "c1", args}),
			makeTextResponse("done"),
		},
	}

	tools := []*agent.ToolDef{simpleTool("read_file", `{"output":"ok"}`)}
	session := agent.NewSession(s, mock, ws, conv, tools, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("run tool"))
	defer cancel()
	allEvents := collectEvents(events)

	tc := findEvent(allEvents, agent.EventToolCallStart)
	if tc == nil || tc.ToolCall == nil {
		t.Fatal("expected tool call start event")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(tc.ToolCall.Args), &parsed); err != nil {
		t.Fatalf("tool call args should remain valid json, got error: %v", err)
	}
	pathValue, ok := parsed["path"].(string)
	if !ok {
		t.Fatal("expected path string in tool args json")
	}
	if !strings.Contains(pathValue, "...(truncated)") {
		t.Fatal("expected args text value to be truncated")
	}
	if len(tc.ToolCall.Tags) != 1 || tc.ToolCall.Tags[0] != "read" {
		t.Fatalf("tool call tags = %#v, want [\"read\"]", tc.ToolCall.Tags)
	}

	evts, err := s.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("load ui events: %v", err)
	}

	var foundPersisted bool
	for _, evt := range evts {
		if evt.Kind != models.UIEventKindToolStart {
			continue
		}
		raw, ok := evt.Metadata["args"].(string)
		if !ok || raw == "" {
			continue
		}
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			t.Fatalf("persisted tool args should remain valid json, got error: %v", err)
		}
		tags, _ := evt.Metadata["tool_tags"].([]any)
		if len(tags) != 1 || tags[0] != "read" {
			t.Fatalf("persisted tool tags = %#v, want [\"read\"]", evt.Metadata["tool_tags"])
		}
		foundPersisted = true
		break
	}
	if !foundPersisted {
		t.Fatal("expected persisted tool_start ui event with json args")
	}
}

// ─────────────────────────────────────────────────────────────────
// Session Tests — Max Iterations Guard
// ─────────────────────────────────────────────────────────────────

func TestSessionMaxToolCallIterations(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()
	const testMaxIterations = 8

	// Create a mock that always returns tool calls (infinite loop).
	infiniteResponses := make([][]agent.TurnEvent, testMaxIterations+5)
	for i := range infiniteResponses {
		infiniteResponses[i] = makeToolCallResponse(struct{ Name, CallID, Args string }{
			"loop_tool", fmt.Sprintf("c%d", i), `{}`,
		})
	}

	mock := &mockModelClient{responses: infiniteResponses}

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{simpleTool("loop_tool", `{"ok":true}`)}, 0)
	session.MaxToolCallIterations = testMaxIterations

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Loop forever"))
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

	// Should have been called exactly max iterations times (hit on iteration max+1).
	if int(mock.callCount.Load()) != testMaxIterations {
		t.Errorf("mock calls = %d, want %d", mock.callCount.Load(), testMaxIterations)
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Hi"))
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("hi"))
	defer cancel()
	collectEvents(events)

	if capturedConfig == nil {
		t.Fatal("config not captured")
	}
	if capturedConfig.SystemInstruction == "" {
		t.Errorf("expected system prompt to be populated, got empty string")
	}
	if !strings.Contains(capturedConfig.SystemInstruction, "Output Contract") {
		t.Errorf("system prompt does not match expected assembled instruction, got %q", capturedConfig.SystemInstruction)
	}
}

func TestSessionThinkingLevelAppliedToModelConfig(t *testing.T) {
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	session.ThinkingLevel = "high"
	session.IncludeThoughts = true

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("hi"))
	defer cancel()
	collectEvents(events)

	if capturedConfig == nil {
		t.Fatal("config not captured")
	}
	if capturedConfig.ThinkingLevel == nil {
		t.Fatal("expected thinking level to be set")
	}
	if string(*capturedConfig.ThinkingLevel) != "HIGH" {
		t.Fatalf("expected thinking level HIGH, got %q", *capturedConfig.ThinkingLevel)
	}
	if capturedConfig.IncludeThoughts == nil {
		t.Fatal("expected include thoughts to be set")
	}
	if !*capturedConfig.IncludeThoughts {
		t.Fatal("expected include thoughts=true")
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Hi"))
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

func TestSessionThoughtStatusSummary(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{{
			{Kind: agent.EventDelta, Delta: &agent.StreamDelta{Text: "**Planning Calendar Layout**\n", IsThought: true}},
			{Kind: agent.EventDelta, Delta: &agent.StreamDelta{Text: "working...", IsThought: true}},
			{Kind: agent.EventMessageDone, Message: &models.Message{
				SentBy: models.SentByAgent, State: models.MessageStateCompleted,
				Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "done"}}},
			}},
		}},
	}

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Hi"))
	defer cancel()
	allEvents := collectEvents(events)

	foundThinkingSummary := false
	for _, e := range allEvents {
		if e.Kind == agent.EventStatus && e.Status != nil &&
			strings.Contains(e.Status.Text, "thinking: Planning Calendar Layout") {
			foundThinkingSummary = true
			break
		}
	}
	if !foundThinkingSummary {
		t.Fatal("expected a thinking status summary event")
	}
}

func TestSessionFillsMissingFunctionCallID(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"t", "", `{}`}),
			makeTextResponse("done"),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{simpleTool("t", `{"ok":true}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Go"))
	defer cancel()
	allEvents := collectEvents(events)

	for _, e := range allEvents {
		if e.Kind == agent.EventToolCallStart {
			if e.ToolCall == nil || e.ToolCall.CallID == "" {
				t.Fatal("tool call start emitted empty call_id")
			}
		}
		if e.Kind == agent.EventToolResult {
			if e.ToolResult == nil || e.ToolResult.CallID == "" {
				t.Fatal("tool result emitted empty call_id")
			}
		}
	}

	msgs, err := s.Messages().GetRange(ctx, conv.ID, 1, 100)
	if err != nil {
		t.Fatalf("get messages: %v", err)
	}

	found := false
	for _, m := range msgs {
		if m.SentBy != models.SentByAgent {
			continue
		}
		for _, p := range m.Parts {
			if p.Kind == models.PartFunctionCall && p.FunctionCall != nil {
				found = true
				if p.FunctionCall.CallID == "" {
					t.Fatal("persisted function call still has empty call_id")
				}
			}
		}
	}
	if !found {
		t.Fatal("expected persisted function call message")
	}
}

func TestSessionStatusIncludesToolActionSummary(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"shell", "c1", `{"command":"go test ./..."}`}),
			makeTextResponse("done"),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{simpleTool("shell", `{"output":"ok"}`)}, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Run checks"))
	defer cancel()
	allEvents := collectEvents(events)

	var statuses []string
	for _, e := range allEvents {
		if e.Kind == agent.EventStatus && e.Status != nil {
			statuses = append(statuses, e.Status.Text)
		}
	}

	joined := strings.Join(statuses, "\n")
	if !strings.Contains(joined, "executing 1 tool call(s): shell") {
		t.Fatalf("missing tool list status, got:\n%s", joined)
	}
	if !strings.Contains(joined, "tool 1/1 shell: go test ./...") {
		t.Fatalf("missing tool action summary, got:\n%s", joined)
	}
	if !strings.Contains(joined, "tool 1/1 shell completed") {
		t.Fatalf("missing tool completion summary, got:\n%s", joined)
	}
}

func TestSessionStatusIncludesThreadUpdateSummary(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			makeToolCallResponse(struct{ Name, CallID, Args string }{"spawn_thread", "c1", `{"title":"t1","mode":"async","context_strategy":"full_chain","task":"x"}`}),
			makeTextResponse("done"),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{simpleTool("spawn_thread", `{"thread_id":"12345678-1234-1234-1234-1234567890ab","status":"running"}`)}, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Spawn"))
	defer cancel()
	allEvents := collectEvents(events)

	var statuses []string
	for _, e := range allEvents {
		if e.Kind == agent.EventStatus && e.Status != nil {
			statuses = append(statuses, e.Status.Text)
		}
	}
	joined := strings.Join(statuses, "\n")
	if !strings.Contains(joined, "tool 1/1 spawn_thread thread 12345678 is running") {
		t.Fatalf("missing thread status summary, got:\n%s", joined)
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)

	events1, cancel1, _ := session.HandleUserMessage(ctx, textParts("First"))
	collectEvents(events1)
	cancel1()

	events2, cancel2, _ := session.HandleUserMessage(ctx, textParts("Second"))
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

	session := agent.NewSession(s, mock, ws, thread, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Thread question"))
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

func TestSessionBuildHistoryPrunesPriorToolResultsOnFollowUp(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "u-old",
		ConversationID: conv.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts:          textParts("first turn"),
	}); err != nil {
		t.Fatalf("append old user: %v", err)
	}
	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "a-old",
		ConversationID: conv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts: []models.MessagePart{{
			Kind: models.PartFunctionCall,
			FunctionCall: &models.FunctionCallPart{
				CallID:   "old-call",
				Name:     "exec_command",
				ArgsJSON: json.RawMessage(`{"cmd":"pwd"}`),
			},
		}},
	}); err != nil {
		t.Fatalf("append old agent: %v", err)
	}
	originalToolJSON := `{"output":"old output","session_id":17}`
	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "t-old",
		ConversationID: conv.ID,
		SentBy:         models.SentByTool,
		State:          models.MessageStateCompleted,
		Parts:          toolResponsePart("old-call", "exec_command", originalToolJSON),
	}); err != nil {
		t.Fatalf("append old tool: %v", err)
	}
	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "a-old-text",
		ConversationID: conv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts:          textParts("done"),
	}); err != nil {
		t.Fatalf("append old agent text: %v", err)
	}

	var capturedHistory []*models.Message
	mock := &historyCaptureMock{
		inner:           &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("next")}},
		captureCallback: func(h []*models.Message) { capturedHistory = h },
	}

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, textParts("follow up"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()
	collectEvents(events)

	got := historyToolResponseMap(t, capturedHistory, "old-call")
	if got["output"] != "[Old tool result content cleared]" {
		t.Fatalf("history output = %#v, want placeholder", got["output"])
	}
	if got["session_id"] != float64(17) {
		t.Fatalf("history session_id = %#v, want 17", got["session_id"])
	}

	msgs, err := s.Messages().GetRange(ctx, conv.ID, 1, 20)
	if err != nil {
		t.Fatalf("load messages: %v", err)
	}
	persisted := historyToolResponseMap(t, msgs, "old-call")
	if persisted["output"] != "old output" {
		t.Fatalf("persisted output = %#v, want original", persisted["output"])
	}
}

func TestSessionBuildHistoryKeepsCurrentTurnToolResults(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "u-old",
		ConversationID: conv.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts:          textParts("previous"),
	}); err != nil {
		t.Fatalf("append old user: %v", err)
	}
	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "t-old",
		ConversationID: conv.ID,
		SentBy:         models.SentByTool,
		State:          models.MessageStateCompleted,
		Parts:          toolResponsePart("old-call", "read_file", `{"output":"stale contents","success":true}`),
	}); err != nil {
		t.Fatalf("append old tool: %v", err)
	}

	var histories [][]*models.Message
	captureMock := &historyCaptureMock{
		inner: &mockModelClient{
			responses: [][]agent.TurnEvent{
				makeToolCallResponse(struct{ Name, CallID, Args string }{"echo", "fresh-call", `{}`}),
				makeTextResponse("done"),
			},
		},
		captureCallback: func(h []*models.Message) {
			snapshot := append([]*models.Message(nil), h...)
			histories = append(histories, snapshot)
		},
	}

	session := agent.NewSession(s, captureMock, ws, conv, []*agent.ToolDef{simpleTool("echo", `{"output":"fresh output","session_id":42}`)}, 0)
	events, cancel, err := session.HandleUserMessage(ctx, textParts("follow up"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()
	collectEvents(events)

	if len(histories) != 2 {
		t.Fatalf("histories = %d, want 2", len(histories))
	}

	firstOld := historyToolResponseMap(t, histories[0], "old-call")
	if firstOld["output"] != "[Old tool result content cleared]" {
		t.Fatalf("first old output = %#v, want placeholder", firstOld["output"])
	}

	secondOld := historyToolResponseMap(t, histories[1], "old-call")
	if secondOld["output"] != "[Old tool result content cleared]" {
		t.Fatalf("second old output = %#v, want placeholder", secondOld["output"])
	}

	secondFresh := historyToolResponseMap(t, histories[1], "fresh-call")
	if secondFresh["output"] != "fresh output" {
		t.Fatalf("fresh output = %#v, want fresh output", secondFresh["output"])
	}
	if secondFresh["session_id"] != float64(42) {
		t.Fatalf("fresh session_id = %#v, want 42", secondFresh["session_id"])
	}
}

func TestSessionThreadHistoryPrunesParentToolResults(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ws := &models.Workspace{ID: "ws-1", Name: "W", RootPath: "/tmp", CanonicalRootPath: "/tmp"}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	parent := &models.Conversation{ID: "parent", WorkspaceID: "ws-1", Title: "Parent"}
	if err := s.Conversations().Create(ctx, parent); err != nil {
		t.Fatalf("create parent conversation: %v", err)
	}
	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "pm1",
		ConversationID: parent.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts:          textParts("launch child"),
	}); err != nil {
		t.Fatalf("append parent user: %v", err)
	}
	if err := s.Messages().Append(ctx, &models.Message{
		ID:             "pm2",
		ConversationID: parent.ID,
		SentBy:         models.SentByTool,
		State:          models.MessageStateCompleted,
		Parts:          toolResponsePart("parent-call", "spawn_thread", `{"thread_id":"thread-123","status":"completed","result":"child answer"}`),
	}); err != nil {
		t.Fatalf("append parent tool: %v", err)
	}

	thread := &models.Conversation{
		ID:                   "thread",
		WorkspaceID:          "ws-1",
		Title:                "Thread",
		ParentConversationID: "parent",
		AnchorMessageID:      "pm2",
	}
	if err := s.Conversations().Create(ctx, thread); err != nil {
		t.Fatalf("create thread: %v", err)
	}

	var capturedHistory []*models.Message
	mock := &historyCaptureMock{
		inner:           &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("thread response")}},
		captureCallback: func(h []*models.Message) { capturedHistory = h },
	}

	session := agent.NewSession(s, mock, ws, thread, nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, textParts("follow up in thread"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()
	collectEvents(events)

	got := historyToolResponseMap(t, capturedHistory, "parent-call")
	if got["thread_id"] != "thread-123" {
		t.Fatalf("thread_id = %#v, want thread-123", got["thread_id"])
	}
	if got["status"] != "completed" {
		t.Fatalf("status = %#v, want completed", got["status"])
	}
	if got["result"] != "[Old tool result content cleared]" {
		t.Fatalf("result = %#v, want placeholder", got["result"])
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, err := session.HandleUserMessage(ctx, textParts(""))
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

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{simpleTool("t", `{}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Go"))
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

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Hello"))
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

	session := agent.NewSession(s, mock, ws, conv, []*agent.ToolDef{simpleTool("t", `{}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Go"))
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

	session := agent.NewSession(s, captureMock, ws, conv, []*agent.ToolDef{simpleTool("t", `{}`)}, 0)

	events, cancel, _ := session.HandleUserMessage(ctx, textParts("Go"))
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

func TestSessionEmitsModelWaitEventsPerAttempt(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{
		responses: [][]agent.TurnEvent{
			{
				{
					Kind:      agent.EventError,
					Error:     fmt.Errorf("503 Service Unavailable"),
					ErrorText: "503 Service Unavailable",
				},
			},
			makeTextResponse("Recovered after retry."),
		},
	}

	session := agent.NewSession(s, mock, ws, conv, nil, 0)
	session.MaxModelRetries = 1
	session.RetryDelay = 20 * time.Millisecond
	session.RetryTick = 10 * time.Millisecond

	events, cancel, err := session.HandleUserMessage(ctx, textParts("retry please"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)
	var started, finished int
	var outcomes []string
	for _, e := range allEvents {
		if e.Kind == agent.EventModelWaitStarted {
			started++
		}
		if e.Kind == agent.EventModelWaitFinished && e.ModelWaitFinished != nil {
			finished++
			outcomes = append(outcomes, e.ModelWaitFinished.Outcome)
		}
	}
	if started != 2 || finished != 2 {
		t.Fatalf("model wait events mismatch started=%d finished=%d", started, finished)
	}
	if len(outcomes) != 2 || outcomes[0] != "retry" || outcomes[1] != "success" {
		t.Fatalf("unexpected model wait outcomes: %v", outcomes)
	}
}

func TestSessionEmitsStateTransitions(t *testing.T) {
	s := newTestStore(t)
	ws, conv := seedConversation(t, s)
	ctx := context.Background()

	mock := &mockModelClient{responses: [][]agent.TurnEvent{makeTextResponse("ok")}}
	session := agent.NewSession(s, mock, ws, conv, nil, 0)

	events, cancel, err := session.HandleUserMessage(ctx, textParts("hi"))
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	defer cancel()

	allEvents := collectEvents(events)
	var transitions []string
	for _, e := range allEvents {
		if e.Kind == agent.EventStateTransition && e.StateTransition != nil {
			transitions = append(transitions, e.StateTransition.To)
		}
	}
	if len(transitions) == 0 {
		t.Fatal("expected state transition events")
	}
	if transitions[len(transitions)-1] != string(agent.StateTurnCompleted) {
		t.Fatalf("last state transition=%q want=%q", transitions[len(transitions)-1], agent.StateTurnCompleted)
	}
}
