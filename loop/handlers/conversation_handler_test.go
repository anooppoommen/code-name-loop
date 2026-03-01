package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"loop/models"
	"loop/store/sqlite"
)

func TestTimelineOrderedBySharedTimelineSeq(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{ID: "ws-1", Name: "W", RootPath: "/tmp", CanonicalRootPath: "/tmp"}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}
	conv := &models.Conversation{ID: "conv-1", WorkspaceID: ws.ID, Title: "C"}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatal(err)
	}

	msg1 := &models.Message{
		ID:             "m1",
		ConversationID: conv.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts:          []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "one"}}},
	}
	if err := s.Messages().Append(ctx, msg1); err != nil {
		t.Fatal(err)
	}
	evt1 := &models.UIEvent{
		ConversationID: conv.ID,
		Kind:           models.UIEventKindStatus,
		Text:           "status one",
	}
	if err := s.UIEvents().Append(ctx, evt1); err != nil {
		t.Fatal(err)
	}
	msg2 := &models.Message{
		ID:             "m2",
		ConversationID: conv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts:          []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "two"}}},
	}
	if err := s.Messages().Append(ctx, msg2); err != nil {
		t.Fatal(err)
	}

	h := NewConversationHandler(s, nil, nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/conversations/conv-1/timeline", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var rows []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows=%d want=3", len(rows))
	}

	assertRow := func(idx int, wantType, wantID string, wantTimelineSeq float64) {
		row := rows[idx]
		if got := row["type"]; got != wantType {
			t.Fatalf("row[%d].type=%v want=%s", idx, got, wantType)
		}
		if got := row["timeline_seq"]; got != wantTimelineSeq {
			t.Fatalf("row[%d].timeline_seq=%v want=%v", idx, got, wantTimelineSeq)
		}
		record, ok := row[wantType].(map[string]any)
		if !ok {
			t.Fatalf("row[%d].%s missing", idx, wantType)
		}
		gotID, _ := record["ID"]
		if gotID == nil {
			gotID, _ = record["id"]
		}
		if gotID != wantID {
			t.Fatalf("row[%d].%s.id=%v want=%s", idx, wantType, gotID, wantID)
		}
	}

	assertRow(0, "message", "m1", 1)
	assertRow(1, "ui_event", evt1.ID, 2)
	assertRow(2, "message", "m2", 3)
}

func TestParseThreadStatus(t *testing.T) {
	evt := parseThreadStatus("[thread 12345678] completed")
	if evt.ThreadID != "12345678" {
		t.Fatalf("thread_id=%q", evt.ThreadID)
	}
	if evt.Status != "completed" || evt.Phase != "completed" {
		t.Fatalf("status=%q phase=%q", evt.Status, evt.Phase)
	}
}

func TestCommandPaletteSearchReturnsThreadMatchesAndActiveTasks(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{
		ID:                "ws-search",
		Name:              "Workspace Search",
		RootPath:          "/tmp/search",
		CanonicalRootPath: "/tmp/search",
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}

	rootConv := &models.Conversation{
		ID:          "conv-root",
		WorkspaceID: ws.ID,
		Title:       "Root Planning",
	}
	if err := s.Conversations().Create(ctx, rootConv); err != nil {
		t.Fatal(err)
	}

	anchorMsg := &models.Message{
		ID:             "msg-anchor",
		ConversationID: rootConv.ID,
		SentBy:         models.SentByUser,
		State:          models.MessageStateCompleted,
		Parts: []models.MessagePart{
			{Kind: models.PartText, Text: &models.TextPart{Text: "Discuss build strategy"}},
		},
	}
	if err := s.Messages().Append(ctx, anchorMsg); err != nil {
		t.Fatal(err)
	}

	threadConv := &models.Conversation{
		ID:                   "conv-thread",
		WorkspaceID:          ws.ID,
		Title:                "Investigate slowdown",
		ParentConversationID: rootConv.ID,
		AnchorMessageID:      anchorMsg.ID,
		ThreadMode:           models.ThreadModeAsync,
		ThreadStatus:         models.ThreadStatusRunning,
	}
	if err := s.Conversations().Create(ctx, threadConv); err != nil {
		t.Fatal(err)
	}

	threadMsg := &models.Message{
		ID:             "msg-thread",
		ConversationID: threadConv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateCompleted,
		Parts: []models.MessagePart{
			{Kind: models.PartText, Text: &models.TextPart{Text: "Found bottleneck in queue processing path"}},
		},
	}
	if err := s.Messages().Append(ctx, threadMsg); err != nil {
		t.Fatal(err)
	}

	runningRootMsg := &models.Message{
		ID:             "msg-running",
		ConversationID: rootConv.ID,
		SentBy:         models.SentByAgent,
		State:          models.MessageStateRunning,
		Parts: []models.MessagePart{
			{Kind: models.PartText, Text: &models.TextPart{Text: "Analyzing repository now"}},
		},
	}
	if err := s.Messages().Append(ctx, runningRootMsg); err != nil {
		t.Fatal(err)
	}

	h := NewConversationHandler(s, nil, nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	searchReq := httptest.NewRequest(http.MethodGet, "/command-palette/search?q=bottleneck&workspace_id=ws-search", nil)
	searchRec := httptest.NewRecorder()
	mux.ServeHTTP(searchRec, searchReq)
	if searchRec.Code != http.StatusOK {
		t.Fatalf("search status=%d body=%s", searchRec.Code, searchRec.Body.String())
	}

	var searchResp struct {
		Conversations []struct {
			ConversationID     string `json:"conversation_id"`
			RootConversationID string `json:"root_conversation_id"`
			IsThread           bool   `json:"is_thread"`
			MatchKind          string `json:"match_kind"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(searchRec.Body.Bytes(), &searchResp); err != nil {
		t.Fatalf("decode search response: %v", err)
	}

	foundThreadHit := false
	for _, conv := range searchResp.Conversations {
		if conv.ConversationID != "conv-thread" {
			continue
		}
		foundThreadHit = true
		if !conv.IsThread {
			t.Fatalf("thread hit should set is_thread=true")
		}
		if conv.MatchKind != "message" {
			t.Fatalf("thread hit match_kind=%q want=message", conv.MatchKind)
		}
		if conv.RootConversationID != "conv-root" {
			t.Fatalf("thread hit root_conversation_id=%q want=conv-root", conv.RootConversationID)
		}
	}
	if !foundThreadHit {
		t.Fatalf("expected thread message hit in search response")
	}

	activeReq := httptest.NewRequest(http.MethodGet, "/command-palette/search?workspace_id=ws-search", nil)
	activeRec := httptest.NewRecorder()
	mux.ServeHTTP(activeRec, activeReq)
	if activeRec.Code != http.StatusOK {
		t.Fatalf("active status=%d body=%s", activeRec.Code, activeRec.Body.String())
	}

	var activeResp struct {
		ActiveTasks []struct {
			ConversationID string `json:"conversation_id"`
			MatchKind      string `json:"match_kind"`
		} `json:"active_tasks"`
	}
	if err := json.Unmarshal(activeRec.Body.Bytes(), &activeResp); err != nil {
		t.Fatalf("decode active response: %v", err)
	}

	hasRunningRoot := false
	hasRunningThread := false
	for _, task := range activeResp.ActiveTasks {
		if task.MatchKind != "running" {
			t.Fatalf("active task match_kind=%q want=running", task.MatchKind)
		}
		if task.ConversationID == "conv-root" {
			hasRunningRoot = true
		}
		if task.ConversationID == "conv-thread" {
			hasRunningThread = true
		}
	}
	if !hasRunningRoot {
		t.Fatalf("expected root conversation in active tasks")
	}
	if !hasRunningThread {
		t.Fatalf("expected thread conversation in active tasks")
	}
}
