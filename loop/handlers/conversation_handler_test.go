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
