package sqlite_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"loop/models"
	"loop/store/sqlite"
)

// ─────────────────────────────────────────────────────────────────
// Workspace CRUD Tests
// ─────────────────────────────────────────────────────────────────

func TestWorkspaceCreateAndGet(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{
		ID:                "ws-1",
		Name:              "My Project",
		RootPath:          "/home/user/project",
		CanonicalRootPath: "/home/user/project",
		PathGrants: []models.PathGrant{
			{
				CanonicalPath: "/usr/local/share",
				DeclaredPath:  "/usr/local/share",
				IsDirectory:   true,
				Mode:          models.PathAccessRead,
			},
			{
				CanonicalPath: "/tmp/output.log",
				DeclaredPath:  "~/output.log",
				IsDirectory:   false,
				Mode:          models.PathAccessWrite,
			},
		},
	}

	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.Workspaces().Get(ctx, "ws-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if got.Name != "My Project" {
		t.Errorf("Name = %q, want %q", got.Name, "My Project")
	}
	if got.CanonicalRootPath != "/home/user/project" {
		t.Errorf("CanonicalRootPath = %q, want %q", got.CanonicalRootPath, "/home/user/project")
	}
	if len(got.PathGrants) != 2 {
		t.Fatalf("PathGrants count = %d, want 2", len(got.PathGrants))
	}
	if got.PathGrants[0].Mode != models.PathAccessRead {
		t.Errorf("PathGrants[0].Mode = %q, want %q", got.PathGrants[0].Mode, models.PathAccessRead)
	}
	if got.PathGrants[1].IsDirectory != false {
		t.Error("PathGrants[1].IsDirectory should be false")
	}
}

func TestWorkspaceGetByRootPath(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{
		ID:                "ws-root-1",
		Name:              "Root Test",
		RootPath:          "/path/to/project",
		CanonicalRootPath: "/canonical/path/to/project",
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}

	got, err := s.Workspaces().GetByRootPath(ctx, "/canonical/path/to/project")
	if err != nil {
		t.Fatalf("GetByRootPath: %v", err)
	}
	if got.ID != "ws-root-1" {
		t.Errorf("ID = %q, want %q", got.ID, "ws-root-1")
	}
}

func TestWorkspaceUpdate(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{
		ID:                "ws-upd",
		Name:              "Original",
		RootPath:          "/original",
		CanonicalRootPath: "/original",
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}

	ws.Name = "Updated"
	ws.PathGrants = []models.PathGrant{
		{CanonicalPath: "/new/path", IsDirectory: true, Mode: models.PathAccessWrite},
	}
	if err := s.Workspaces().Update(ctx, ws); err != nil {
		t.Fatal(err)
	}

	got, err := s.Workspaces().Get(ctx, "ws-upd")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Updated" {
		t.Errorf("Name = %q, want %q", got.Name, "Updated")
	}
	if len(got.PathGrants) != 1 {
		t.Fatalf("PathGrants count = %d, want 1", len(got.PathGrants))
	}
	if got.PathGrants[0].Mode != models.PathAccessWrite {
		t.Errorf("PathGrants[0].Mode = %q, want %q", got.PathGrants[0].Mode, models.PathAccessWrite)
	}
}

func TestWorkspaceDelete(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{
		ID:                "ws-del",
		Name:              "ToDelete",
		RootPath:          "/del",
		CanonicalRootPath: "/del",
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}

	if err := s.Workspaces().Delete(ctx, "ws-del"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	_, err = s.Workspaces().Get(ctx, "ws-del")
	if err == nil {
		t.Fatal("expected error after delete, got nil")
	}
}

func TestWorkspaceList(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	for i := 0; i < 3; i++ {
		ws := &models.Workspace{
			ID:                models.WorkspaceID(fmt.Sprintf("ws-%d", i)),
			Name:              fmt.Sprintf("Workspace %d", i),
			RootPath:          fmt.Sprintf("/root/%d", i),
			CanonicalRootPath: fmt.Sprintf("/root/%d", i),
		}
		if err := s.Workspaces().Create(ctx, ws); err != nil {
			t.Fatal(err)
		}
	}

	list, err := s.Workspaces().List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("List count = %d, want 3", len(list))
	}
}

// ─────────────────────────────────────────────────────────────────
// Conversation CRUD Tests
// ─────────────────────────────────────────────────────────────────

func TestConversationCreateAndGet(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()

	// First create a workspace.
	ws := &models.Workspace{
		ID: "ws-conv", Name: "Conv WS",
		RootPath: "/conv", CanonicalRootPath: "/conv",
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}

	conv := &models.Conversation{
		ID:               "conv-1",
		WorkspaceID:      "ws-conv",
		Title:            "First Conversation",
		SystemPromptID:   "gemini-coding-strict-optimized.v7",
		SystemPromptName: "Gemini Coding Strict Optimized V7",
	}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.Conversations().Get(ctx, "conv-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Title != "First Conversation" {
		t.Errorf("Title = %q, want %q", got.Title, "First Conversation")
	}
	if got.SystemPromptID != "gemini-coding-strict-optimized.v7" {
		t.Errorf("SystemPromptID = %q", got.SystemPromptID)
	}
	if got.SystemPromptName != "Gemini Coding Strict Optimized V7" {
		t.Errorf("SystemPromptName = %q", got.SystemPromptName)
	}
	if got.IsThread() {
		t.Error("root conversation should not be a thread")
	}
}

func TestConversationThreads(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{
		ID: "ws-th", Name: "Thread WS",
		RootPath: "/th", CanonicalRootPath: "/th",
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}

	// Root conversation.
	root := &models.Conversation{
		ID: "conv-root", WorkspaceID: "ws-th", Title: "Root",
	}
	if err := s.Conversations().Create(ctx, root); err != nil {
		t.Fatal(err)
	}

	// Thread 1 anchored at "msg-c".
	thread1 := &models.Conversation{
		ID:                   "thread-1",
		WorkspaceID:          "ws-th",
		Title:                "Thread at C",
		ParentConversationID: "conv-root",
		AnchorMessageID:      "msg-c",
	}
	if err := s.Conversations().Create(ctx, thread1); err != nil {
		t.Fatal(err)
	}

	// Thread 2 also anchored at "msg-c".
	thread2 := &models.Conversation{
		ID:                   "thread-2",
		WorkspaceID:          "ws-th",
		Title:                "Thread 2 at C",
		ParentConversationID: "conv-root",
		AnchorMessageID:      "msg-c",
	}
	if err := s.Conversations().Create(ctx, thread2); err != nil {
		t.Fatal(err)
	}

	threads, err := s.Conversations().ListThreads(ctx, "conv-root")
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 2 {
		t.Fatalf("ListThreads count = %d, want 2", len(threads))
	}
	if !threads[0].IsThread() {
		t.Error("thread should be marked as thread")
	}
}

// ─────────────────────────────────────────────────────────────────
// Message Tests — Append, Range, and Parent History
// ─────────────────────────────────────────────────────────────────

func TestMessageAppendAndAutoSeq(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-msg", Name: "Msg WS", RootPath: "/msg", CanonicalRootPath: "/msg"}
	s.Workspaces().Create(ctx, ws)
	conv := &models.Conversation{ID: "conv-msg", WorkspaceID: "ws-msg", Title: "Messages"}
	s.Conversations().Create(ctx, conv)

	// Append 3 messages.
	for i := 0; i < 3; i++ {
		msg := &models.Message{
			ID:             models.MessageID(fmt.Sprintf("msg-%d", i)),
			ConversationID: "conv-msg",
			SentBy:         models.SentByUser,
			State:          models.MessageStateCompleted,
			Parts: []models.MessagePart{
				{
					Kind: models.PartText,
					Text: &models.TextPart{Text: fmt.Sprintf("Message %d", i)},
				},
			},
		}
		if err := s.Messages().Append(ctx, msg); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
		if msg.Seq != int64(i+1) {
			t.Errorf("msg %d: Seq = %d, want %d", i, msg.Seq, i+1)
		}
	}

	// Verify get.
	got, err := s.Messages().Get(ctx, "msg-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Seq != 2 {
		t.Errorf("msg-1 Seq = %d, want 2", got.Seq)
	}
	if len(got.Parts) != 1 || got.Parts[0].Text.Text != "Message 1" {
		t.Errorf("unexpected parts: %+v", got.Parts)
	}
}

func TestMessageGetRange(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-range", Name: "R", RootPath: "/r", CanonicalRootPath: "/r"}
	s.Workspaces().Create(ctx, ws)
	conv := &models.Conversation{ID: "conv-range", WorkspaceID: "ws-range", Title: "Range"}
	s.Conversations().Create(ctx, conv)

	// Append messages A(1), B(2), C(3), D(4), E(5).
	ids := []string{"A", "B", "C", "D", "E"}
	for _, id := range ids {
		msg := &models.Message{
			ID:             models.MessageID("msg-" + id),
			ConversationID: "conv-range",
			SentBy:         models.SentByUser,
			State:          models.MessageStateCompleted,
			Parts: []models.MessagePart{
				{Kind: models.PartText, Text: &models.TextPart{Text: "Message " + id}},
			},
		}
		s.Messages().Append(ctx, msg)
	}

	// Get range A(seq 1) to E(seq 5) — should return all 5.
	msgs, err := s.Messages().GetRange(ctx, "conv-range", 1, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 5 {
		t.Fatalf("GetRange(1,5) count = %d, want 5", len(msgs))
	}
	for i, msg := range msgs {
		if msg.Seq != int64(i+1) {
			t.Errorf("msg[%d].Seq = %d, want %d", i, msg.Seq, i+1)
		}
	}

	// Get range B(2) to D(4) — should return 3 messages.
	msgs, err = s.Messages().GetRange(ctx, "conv-range", 2, 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 3 {
		t.Fatalf("GetRange(2,4) count = %d, want 3", len(msgs))
	}
	if string(msgs[0].ID) != "msg-B" {
		t.Errorf("first msg ID = %q, want %q", msgs[0].ID, "msg-B")
	}
}

// TestMessageParentHistory validates the PRD's core example:
//
//	Root conversation: A → B → C → D → E
//	Thread at C: C1 → C2 → C3
//	GetParentHistory(thread, 3) = A → B → C → C1 → C2 → C3
func TestMessageParentHistory(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()

	// Setup workspace.
	ws := &models.Workspace{ID: "ws-ph", Name: "PH", RootPath: "/ph", CanonicalRootPath: "/ph"}
	s.Workspaces().Create(ctx, ws)

	// Root conversation with messages A, B, C, D, E.
	rootConv := &models.Conversation{ID: "root-conv", WorkspaceID: "ws-ph", Title: "Root"}
	s.Conversations().Create(ctx, rootConv)

	rootMsgs := []string{"A", "B", "C", "D", "E"}
	for _, id := range rootMsgs {
		msg := &models.Message{
			ID: models.MessageID("msg-" + id), ConversationID: "root-conv",
			SentBy: models.SentByUser, State: models.MessageStateCompleted,
			Parts: []models.MessagePart{
				{Kind: models.PartText, Text: &models.TextPart{Text: id}},
			},
		}
		s.Messages().Append(ctx, msg)
	}

	// Thread conversation anchored at msg-C (seq 3 in root).
	threadConv := &models.Conversation{
		ID: "thread-conv", WorkspaceID: "ws-ph", Title: "Thread at C",
		ParentConversationID: "root-conv",
		AnchorMessageID:      "msg-C",
	}
	s.Conversations().Create(ctx, threadConv)

	// Thread messages: C1, C2, C3.
	threadMsgs := []string{"C1", "C2", "C3"}
	for _, id := range threadMsgs {
		msg := &models.Message{
			ID: models.MessageID("msg-" + id), ConversationID: "thread-conv",
			SentBy: models.SentByAgent, State: models.MessageStateCompleted,
			Parts: []models.MessagePart{
				{Kind: models.PartText, Text: &models.TextPart{Text: id}},
			},
		}
		s.Messages().Append(ctx, msg)
	}

	// GetParentHistory for thread-conv up to seq 3 (C3).
	history, err := s.Messages().GetParentHistory(ctx, "thread-conv", 3)
	if err != nil {
		t.Fatalf("GetParentHistory: %v", err)
	}

	// Expected: A(root seq 1), B(root seq 2), C(root seq 3), C1(thread seq 1), C2(thread seq 2), C3(thread seq 3)
	expected := []string{"A", "B", "C", "C1", "C2", "C3"}
	if len(history) != len(expected) {
		t.Fatalf("history count = %d, want %d", len(history), len(expected))
	}
	for i, msg := range history {
		text := msg.Parts[0].Text.Text
		if text != expected[i] {
			t.Errorf("history[%d] = %q, want %q", i, text, expected[i])
		}
	}
}

// TestMessageParentHistoryNested validates nested threads:
//
//	Root: A → B → C
//	Thread1 at C: C1 → C2
//	Thread2 at C2 in Thread1: X1 → X2
//	GetParentHistory(Thread2, 2) = A → B → C → C1 → C2 → X1 → X2
func TestMessageParentHistoryNested(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-nested", Name: "N", RootPath: "/n", CanonicalRootPath: "/n"}
	s.Workspaces().Create(ctx, ws)

	// Root conversation.
	rootConv := &models.Conversation{ID: "nested-root", WorkspaceID: "ws-nested", Title: "Root"}
	s.Conversations().Create(ctx, rootConv)
	for _, id := range []string{"A", "B", "C"} {
		s.Messages().Append(ctx, &models.Message{
			ID: models.MessageID("n-" + id), ConversationID: "nested-root",
			SentBy: models.SentByUser, State: models.MessageStateCompleted,
			Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: id}}},
		})
	}

	// Thread1 at C.
	thread1 := &models.Conversation{
		ID: "nested-t1", WorkspaceID: "ws-nested", Title: "Thread1",
		ParentConversationID: "nested-root", AnchorMessageID: "n-C",
	}
	s.Conversations().Create(ctx, thread1)
	for _, id := range []string{"C1", "C2"} {
		s.Messages().Append(ctx, &models.Message{
			ID: models.MessageID("n-" + id), ConversationID: "nested-t1",
			SentBy: models.SentByAgent, State: models.MessageStateCompleted,
			Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: id}}},
		})
	}

	// Thread2 at C2 (inside Thread1).
	thread2 := &models.Conversation{
		ID: "nested-t2", WorkspaceID: "ws-nested", Title: "Thread2",
		ParentConversationID: "nested-t1", AnchorMessageID: "n-C2",
	}
	s.Conversations().Create(ctx, thread2)
	for _, id := range []string{"X1", "X2"} {
		s.Messages().Append(ctx, &models.Message{
			ID: models.MessageID("n-" + id), ConversationID: "nested-t2",
			SentBy: models.SentByAgent, State: models.MessageStateCompleted,
			Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: id}}},
		})
	}

	// GetParentHistory for thread2 up to seq 2 (X2).
	history, err := s.Messages().GetParentHistory(ctx, "nested-t2", 2)
	if err != nil {
		t.Fatalf("GetParentHistory: %v", err)
	}

	expected := []string{"A", "B", "C", "C1", "C2", "X1", "X2"}
	if len(history) != len(expected) {
		t.Fatalf("history count = %d, want %d", len(history), len(expected))
	}
	for i, msg := range history {
		text := msg.Parts[0].Text.Text
		if text != expected[i] {
			t.Errorf("history[%d] = %q, want %q", i, text, expected[i])
		}
	}
}

// ─────────────────────────────────────────────────────────────────
// Message Part Serialization (JSON round-trip)
// ─────────────────────────────────────────────────────────────────

func TestMessagePartJSONRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-json", Name: "J", RootPath: "/j", CanonicalRootPath: "/j"}
	s.Workspaces().Create(ctx, ws)
	conv := &models.Conversation{ID: "conv-json", WorkspaceID: "ws-json", Title: "JSON"}
	s.Conversations().Create(ctx, conv)

	// Create a message with multiple diverse part types.
	msg := &models.Message{
		ID:             "msg-json-1",
		ConversationID: "conv-json",
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts: []models.MessagePart{
			{
				Kind:             models.PartThought,
				Thought:          &models.ThoughtPart{Text: "Let me think about this..."},
				ThoughtSignature: []byte{0xDE, 0xAD, 0xBE, 0xEF},
			},
			{
				Kind: models.PartText,
				Text: &models.TextPart{Text: "Here is my response."},
			},
			{
				Kind: models.PartFunctionCall,
				FunctionCall: &models.FunctionCallPart{
					CallID:   "call-123",
					Name:     "read_file",
					ArgsJSON: json.RawMessage(`{"path":"/foo/bar.go"}`),
				},
				ThoughtSignature: []byte{0xCA, 0xFE},
			},
		},
		Metadata: map[string]any{
			"model":  "gemini-2.5-flash",
			"tokens": float64(42),
		},
		Attachments: []models.Attachment{
			{
				ID:      "att-1",
				Type:    models.AttachmentTypeToolTrace,
				Content: map[string]any{"trace": "something"},
			},
		},
	}

	if err := s.Messages().Append(ctx, msg); err != nil {
		t.Fatalf("Append: %v", err)
	}

	got, err := s.Messages().Get(ctx, "msg-json-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	// Verify part count and ordering.
	if len(got.Parts) != 3 {
		t.Fatalf("Parts count = %d, want 3", len(got.Parts))
	}

	// Part 0: thought with signature.
	if got.Parts[0].Kind != models.PartThought {
		t.Errorf("Parts[0].Kind = %q, want %q", got.Parts[0].Kind, models.PartThought)
	}
	if got.Parts[0].Thought.Text != "Let me think about this..." {
		t.Errorf("Parts[0].Thought.Text = %q", got.Parts[0].Thought.Text)
	}
	if len(got.Parts[0].ThoughtSignature) != 4 || got.Parts[0].ThoughtSignature[0] != 0xDE {
		t.Errorf("Parts[0].ThoughtSignature incorrect: %x", got.Parts[0].ThoughtSignature)
	}

	// Part 1: text.
	if got.Parts[1].Kind != models.PartText {
		t.Errorf("Parts[1].Kind = %q, want %q", got.Parts[1].Kind, models.PartText)
	}

	// Part 2: function call with signature.
	if got.Parts[2].Kind != models.PartFunctionCall {
		t.Errorf("Parts[2].Kind = %q, want %q", got.Parts[2].Kind, models.PartFunctionCall)
	}
	if got.Parts[2].FunctionCall.Name != "read_file" {
		t.Errorf("FunctionCall.Name = %q", got.Parts[2].FunctionCall.Name)
	}
	if string(got.Parts[2].FunctionCall.ArgsJSON) != `{"path":"/foo/bar.go"}` {
		t.Errorf("FunctionCall.ArgsJSON = %s", got.Parts[2].FunctionCall.ArgsJSON)
	}
	if len(got.Parts[2].ThoughtSignature) != 2 {
		t.Errorf("Parts[2].ThoughtSignature length = %d, want 2", len(got.Parts[2].ThoughtSignature))
	}

	// Verify metadata.
	if got.Metadata["model"] != "gemini-2.5-flash" {
		t.Errorf("Metadata[model] = %v", got.Metadata["model"])
	}
}

// ─────────────────────────────────────────────────────────────────
// Concurrent Read/Write Test (WAL Mode Validation)
// ─────────────────────────────────────────────────────────────────

func TestConcurrentReadWrite(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "concurrent.db")
	s, err := sqlite.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-cc", Name: "CC", RootPath: "/cc", CanonicalRootPath: "/cc"}
	s.Workspaces().Create(ctx, ws)
	conv := &models.Conversation{ID: "conv-cc", WorkspaceID: "ws-cc", Title: "Concurrent"}
	s.Conversations().Create(ctx, conv)

	const numWriters = 10
	const numReaders = 10
	const msgsPerWriter = 20

	var wg sync.WaitGroup
	errCh := make(chan error, numWriters+numReaders)

	// Writers: each appends msgsPerWriter messages.
	for w := 0; w < numWriters; w++ {
		wg.Add(1)
		go func(writerID int) {
			defer wg.Done()
			for i := 0; i < msgsPerWriter; i++ {
				msg := &models.Message{
					ID:             models.MessageID(fmt.Sprintf("cc-w%d-m%d", writerID, i)),
					ConversationID: "conv-cc",
					SentBy:         models.SentByUser,
					State:          models.MessageStateCompleted,
					Parts: []models.MessagePart{
						{Kind: models.PartText, Text: &models.TextPart{Text: fmt.Sprintf("W%d-M%d", writerID, i)}},
					},
				}
				if err := s.Messages().Append(ctx, msg); err != nil {
					errCh <- fmt.Errorf("writer %d msg %d: %w", writerID, i, err)
					return
				}
			}
		}(w)
	}

	// Readers: continuously read ranges while writers are active.
	for r := 0; r < numReaders; r++ {
		wg.Add(1)
		go func(readerID int) {
			defer wg.Done()
			for i := 0; i < msgsPerWriter; i++ {
				_, err := s.Messages().GetRange(ctx, "conv-cc", 1, 1000)
				if err != nil {
					errCh <- fmt.Errorf("reader %d iteration %d: %w", readerID, i, err)
					return
				}
			}
		}(r)
	}

	wg.Wait()
	close(errCh)

	var errors []error
	for e := range errCh {
		errors = append(errors, e)
	}
	if len(errors) > 0 {
		for _, e := range errors {
			t.Errorf("concurrent error: %v", e)
		}
		t.Fatalf("%d concurrent errors occurred (WAL mode may not be working correctly)", len(errors))
	}

	// Verify total messages written.
	msgs, err := s.Messages().GetRange(ctx, "conv-cc", 1, 10000)
	if err != nil {
		t.Fatal(err)
	}
	expectedTotal := numWriters * msgsPerWriter
	if len(msgs) != expectedTotal {
		t.Errorf("total messages = %d, want %d", len(msgs), expectedTotal)
	}

	// Verify all sequence numbers are unique and contiguous.
	seqSet := make(map[int64]bool)
	for _, msg := range msgs {
		if seqSet[msg.Seq] {
			t.Errorf("duplicate seq %d", msg.Seq)
		}
		seqSet[msg.Seq] = true
	}
	for i := int64(1); i <= int64(expectedTotal); i++ {
		if !seqSet[i] {
			t.Errorf("missing seq %d", i)
		}
	}
}

// ─────────────────────────────────────────────────────────────────
// Message Update and Delete
// ─────────────────────────────────────────────────────────────────

func TestMessageUpdateState(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-upd-msg", Name: "U", RootPath: "/u", CanonicalRootPath: "/u"}
	s.Workspaces().Create(ctx, ws)
	conv := &models.Conversation{ID: "conv-upd-msg", WorkspaceID: "ws-upd-msg", Title: "Update"}
	s.Conversations().Create(ctx, conv)

	msg := &models.Message{
		ID: "msg-upd", ConversationID: "conv-upd-msg",
		SentBy: models.SentByAgent, State: models.MessageStatePending,
		Parts: []models.MessagePart{
			{Kind: models.PartText, Text: &models.TextPart{Text: "initial"}},
		},
	}
	s.Messages().Append(ctx, msg)

	// Update state and add a new part.
	msg.State = models.MessageStateCompleted
	msg.Parts = append(msg.Parts, models.MessagePart{
		Kind: models.PartFunctionCall,
		FunctionCall: &models.FunctionCallPart{
			CallID: "call-1", Name: "list_files",
			ArgsJSON: json.RawMessage(`{"dir":"."}`),
		},
	})

	if err := s.Messages().Update(ctx, msg); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, err := s.Messages().Get(ctx, "msg-upd")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != models.MessageStateCompleted {
		t.Errorf("State = %q, want %q", got.State, models.MessageStateCompleted)
	}
	if len(got.Parts) != 2 {
		t.Fatalf("Parts = %d, want 2", len(got.Parts))
	}
}

func TestMessageDelete(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-del-msg", Name: "D", RootPath: "/d", CanonicalRootPath: "/d"}
	s.Workspaces().Create(ctx, ws)
	conv := &models.Conversation{ID: "conv-del-msg", WorkspaceID: "ws-del-msg", Title: "Del"}
	s.Conversations().Create(ctx, conv)

	msg := &models.Message{
		ID: "msg-del", ConversationID: "conv-del-msg",
		SentBy: models.SentByUser, State: models.MessageStateCompleted,
		Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "bye"}}},
	}
	s.Messages().Append(ctx, msg)

	if err := s.Messages().Delete(ctx, "msg-del"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	_, err = s.Messages().Get(ctx, "msg-del")
	if err == nil {
		t.Error("expected error after delete")
	}
}

func TestSharedTimelineSeqAcrossMessagesAndUIEvents(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-tl", Name: "TL", RootPath: "/tl", CanonicalRootPath: "/tl"}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}
	conv := &models.Conversation{ID: "conv-tl", WorkspaceID: "ws-tl", Title: "Timeline"}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatal(err)
	}

	m1 := &models.Message{
		ID:             "msg-tl-1",
		ConversationID: conv.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts:          []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "one"}}},
	}
	if err := s.Messages().Append(ctx, m1); err != nil {
		t.Fatal(err)
	}

	e1 := &models.UIEvent{
		ConversationID: conv.ID,
		Kind:           models.UIEventKindStatus,
		Text:           "status one",
	}
	if err := s.UIEvents().Append(ctx, e1); err != nil {
		t.Fatal(err)
	}

	m2 := &models.Message{
		ID:             "msg-tl-2",
		ConversationID: conv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts:          []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "two"}}},
	}
	if err := s.Messages().Append(ctx, m2); err != nil {
		t.Fatal(err)
	}

	e2 := &models.UIEvent{
		ConversationID: conv.ID,
		Kind:           models.UIEventKindStatus,
		Text:           "status two",
	}
	if err := s.UIEvents().Append(ctx, e2); err != nil {
		t.Fatal(err)
	}

	if m1.TimelineSeq != 1 || e1.TimelineSeq != 2 || m2.TimelineSeq != 3 || e2.TimelineSeq != 4 {
		t.Fatalf("unexpected timeline order m1=%d e1=%d m2=%d e2=%d", m1.TimelineSeq, e1.TimelineSeq, m2.TimelineSeq, e2.TimelineSeq)
	}
}

func TestMessageBranchEditArchivesTailAndKeepsHistory(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-branch", Name: "Branch", RootPath: "/branch", CanonicalRootPath: "/branch"}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}
	conv := &models.Conversation{ID: "conv-branch", WorkspaceID: ws.ID, Title: "Branch test"}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatal(err)
	}

	msg1 := &models.Message{
		ID:             "msg-b-1",
		ConversationID: conv.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts:          []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "original prompt"}}},
	}
	if err := s.Messages().Append(ctx, msg1); err != nil {
		t.Fatal(err)
	}
	msg2 := &models.Message{
		ID:             "msg-b-2",
		ConversationID: conv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts:          []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "old answer"}}},
	}
	if err := s.Messages().Append(ctx, msg2); err != nil {
		t.Fatal(err)
	}
	evt := &models.UIEvent{
		ConversationID: conv.ID,
		Kind:           models.UIEventKindStatus,
		Text:           "old status",
	}
	if err := s.UIEvents().Append(ctx, evt); err != nil {
		t.Fatal(err)
	}

	brancher, ok := s.Messages().(interface {
		BranchFromMessage(context.Context, models.ConversationID, models.MessageID, *models.MessageBranchEdit) (*models.Message, int64, error)
		GetRangeAll(context.Context, models.ConversationID, int64, int64) ([]*models.Message, error)
		GetHistory(context.Context, models.MessageID) ([]*models.MessageHistoryEntry, error)
	})
	if !ok {
		t.Fatal("message store does not support branch operations")
	}

	edited, nextVersion, err := brancher.BranchFromMessage(ctx, conv.ID, msg1.ID, &models.MessageBranchEdit{
		Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "edited prompt"}}},
		Metadata: map[string]any{
			"model":          "gemini-3.1-pro-preview",
			"thinking_level": "medium",
		},
	})
	if err != nil {
		t.Fatalf("branch edit: %v", err)
	}
	if nextVersion != 2 {
		t.Fatalf("next version=%d want=2", nextVersion)
	}
	if edited.Version != 2 {
		t.Fatalf("edited message version=%d want=2", edited.Version)
	}

	activeMsgs, err := s.Messages().GetRange(ctx, conv.ID, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(activeMsgs) != 1 {
		t.Fatalf("active message count=%d want=1", len(activeMsgs))
	}
	if text := activeMsgs[0].Parts[0].Text.Text; text != "edited prompt" {
		t.Fatalf("active edited text=%q want=edited prompt", text)
	}

	allMsgs, err := brancher.GetRangeAll(ctx, conv.ID, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(allMsgs) != 2 {
		t.Fatalf("all message count=%d want=2", len(allMsgs))
	}
	if !allMsgs[1].Archived {
		t.Fatalf("tail message should be archived")
	}

	history, err := brancher.GetHistory(ctx, msg1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 {
		t.Fatalf("history count=%d want=1", len(history))
	}
	if text := history[0].Parts[0].Text.Text; text != "original prompt" {
		t.Fatalf("history text=%q want=original prompt", text)
	}
	if history[0].CreatedByID != msg1.ID {
		t.Fatalf("history created_by_message_id=%q want=%q", history[0].CreatedByID, msg1.ID)
	}

	uiEventReader, ok := s.UIEvents().(interface {
		GetByConversationAll(context.Context, models.ConversationID) ([]*models.UIEvent, error)
	})
	if !ok {
		t.Fatal("ui event store does not support archived reads")
	}
	activeEvents, err := s.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(activeEvents) != 0 {
		t.Fatalf("active ui event count=%d want=0", len(activeEvents))
	}
	allEvents, err := uiEventReader.GetByConversationAll(ctx, conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(allEvents) != 1 || !allEvents[0].Archived {
		t.Fatalf("expected archived ui event after branch rewrite")
	}

	msg3 := &models.Message{
		ID:             "msg-b-3",
		ConversationID: conv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts:          []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "new answer"}}},
	}
	if err := s.Messages().Append(ctx, msg3); err != nil {
		t.Fatal(err)
	}
	if msg3.Version != 2 {
		t.Fatalf("new message version=%d want=2", msg3.Version)
	}
}

// ─────────────────────────────────────────────────────────────────
// Conversation-Root back-pointer on workspace
// ─────────────────────────────────────────────────────────────────

func TestWorkspaceConversationRoots(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-roots", Name: "Roots", RootPath: "/roots", CanonicalRootPath: "/roots"}
	s.Workspaces().Create(ctx, ws)

	// Create 2 conversations (1 root, 1 thread).
	s.Conversations().Create(ctx, &models.Conversation{ID: "root-1", WorkspaceID: "ws-roots", Title: "Root 1"})
	s.Conversations().Create(ctx, &models.Conversation{ID: "root-2", WorkspaceID: "ws-roots", Title: "Root 2"})
	s.Conversations().Create(ctx, &models.Conversation{
		ID: "thread-at-x", WorkspaceID: "ws-roots", Title: "Thread",
		ParentConversationID: "root-1", AnchorMessageID: "some-msg",
	})

	got, err := s.Workspaces().Get(ctx, "ws-roots")
	if err != nil {
		t.Fatal(err)
	}

	// Only root conversations should appear in ConversationRoots.
	if len(got.ConversationRoots) != 2 {
		t.Fatalf("ConversationRoots = %d, want 2", len(got.ConversationRoots))
	}
}

// ─────────────────────────────────────────────────────────────────
// WAL Mode Verification
// ─────────────────────────────────────────────────────────────────

func TestWALModeEnabled(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "wal.db")
	s, err := sqlite.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// The WAL file should exist after creating the DB.
	walPath := dbPath + "-wal"
	if _, err := os.Stat(walPath); os.IsNotExist(err) {
		// WAL file might not be created until first write. Do a write.
		ctx := context.Background()
		ws := &models.Workspace{ID: "ws-wal", Name: "WAL", RootPath: "/wal", CanonicalRootPath: "/wal"}
		s.Workspaces().Create(ctx, ws)

		if _, err := os.Stat(walPath); os.IsNotExist(err) {
			t.Error("WAL file not found — journal mode may not be WAL")
		}
	}
}
