package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"loop/agent"
	"loop/models"
	"loop/store"
	"loop/store/sqlite"
)

type scriptedModelClient struct {
	mu        sync.Mutex
	responses []string
	histories [][]string
}

func (m *scriptedModelClient) StreamMessage(ctx context.Context, history []*models.Message, cfg *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	if cfg != nil && cfg.Model == "gemini-3-flash-preview" {
		ch := make(chan agent.TurnEvent, 1)
		ch <- agent.TurnEvent{Kind: agent.EventMessageDone, Message: &models.Message{Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "Generated Title"}}}}}
		close(ch)
		return ch
	}

	m.mu.Lock()
	captured := make([]string, 0, len(history))
	for _, msg := range history {
		captured = append(captured, messageText(msg))
	}
	m.histories = append(m.histories, captured)
	callIndex := len(m.histories) - 1
	reply := "ok"
	if callIndex < len(m.responses) {
		reply = m.responses[callIndex]
	}
	m.mu.Unlock()

	ch := make(chan agent.TurnEvent, 1)
	if ctx.Err() != nil {
		ch <- agent.TurnEvent{
			Kind:      agent.EventError,
			Error:     ctx.Err(),
			ErrorText: ctx.Err().Error(),
		}
		close(ch)
		return ch
	}

	ch <- agent.TurnEvent{
		Kind: agent.EventMessageDone,
		Message: &models.Message{
			Parts: []models.MessagePart{
				{Kind: models.PartText, Text: &models.TextPart{Text: reply}},
			},
		},
	}
	close(ch)
	return ch
}

func (m *scriptedModelClient) historiesSnapshot() [][]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([][]string, len(m.histories))
	for i := range m.histories {
		out[i] = append([]string(nil), m.histories[i]...)
	}
	return out
}

func messageText(msg *models.Message) string {
	if msg == nil {
		return ""
	}
	var parts []string
	for _, p := range msg.Parts {
		if p.Kind == models.PartText && p.Text != nil {
			txt := strings.TrimSpace(p.Text.Text)
			if txt != "" {
				parts = append(parts, txt)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func setupBranchingHandler(t *testing.T, responses []string) (store.Store, *scriptedModelClient, *http.ServeMux, *models.Conversation) {
	t.Helper()

	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	ws := &models.Workspace{
		ID:                "ws-branching",
		Name:              "Branching WS",
		RootPath:          "/tmp",
		CanonicalRootPath: "/tmp",
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatal(err)
	}
	conv := &models.Conversation{
		ID:          "conv-branching",
		WorkspaceID: ws.ID,
		Title:       "Branching Conversation",
	}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatal(err)
	}

	client := &scriptedModelClient{responses: responses}
	h := NewConversationHandler(s, client, nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return s, client, mux, conv
}

func postReply(t *testing.T, mux *http.ServeMux, convID models.ConversationID, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/conversations/"+string(convID)+"/reply", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func getJSON(t *testing.T, mux *http.ServeMux, path string, out any) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if out != nil && rec.Code >= 200 && rec.Code < 300 {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("decode %s: %v\nbody=%s", path, err, rec.Body.String())
		}
	}
	return rec.Code
}

func TestReplyRetryBranchesFromUserMessageAndArchivesTail(t *testing.T) {
	s, client, mux, conv := setupBranchingHandler(t, []string{"A1", "A2", "A3-retry"})
	defer s.Close()
	ctx := context.Background()

	r1 := postReply(t, mux, conv.ID, map[string]any{"message": "U1"})
	if r1.Code != http.StatusOK {
		t.Fatalf("first reply status=%d body=%s", r1.Code, r1.Body.String())
	}
	r2 := postReply(t, mux, conv.ID, map[string]any{"message": "U2"})
	if r2.Code != http.StatusOK {
		t.Fatalf("second reply status=%d body=%s", r2.Code, r2.Body.String())
	}

	rangeAllReader, ok := s.Messages().(interface {
		GetRangeAll(context.Context, models.ConversationID, int64, int64) ([]*models.Message, error)
	})
	if !ok {
		t.Fatal("message store missing GetRangeAll")
	}
	before, err := rangeAllReader.GetRangeAll(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 4 {
		t.Fatalf("before retry messages=%d want=4", len(before))
	}
	user1ID := before[0].ID

	r3 := postReply(t, mux, conv.ID, map[string]any{"retry_message_id": string(user1ID)})
	if r3.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s", r3.Code, r3.Body.String())
	}

	active, err := s.Messages().GetRange(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 2 {
		t.Fatalf("active messages=%d want=2", len(active))
	}
	if active[0].ID != user1ID {
		t.Fatalf("active first message id=%s want=%s", active[0].ID, user1ID)
	}
	if active[0].Version != 2 || active[1].Version != 2 {
		t.Fatalf("active versions got=(%d,%d) want=(2,2)", active[0].Version, active[1].Version)
	}
	if active[0].Archived || active[1].Archived {
		t.Fatalf("active messages must not be archived")
	}

	allAfter, err := rangeAllReader.GetRangeAll(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	if len(allAfter) != 5 {
		t.Fatalf("all messages=%d want=5", len(allAfter))
	}
	archivedCount := 0
	for _, msg := range allAfter {
		if msg.Archived {
			archivedCount++
		}
	}
	if archivedCount != 3 {
		t.Fatalf("archived messages=%d want=3", archivedCount)
	}

	histories := client.historiesSnapshot()
	if len(histories) != 3 {
		t.Fatalf("model call count=%d want=3", len(histories))
	}
	if len(histories[2]) != 1 || histories[2][0] != "U1" {
		t.Fatalf("retry history=%v want [U1]", histories[2])
	}
}

func TestReplyEditCreatesMessageHistoryAndUsesEditedPrompt(t *testing.T) {
	s, client, mux, conv := setupBranchingHandler(t, []string{"A1", "A1-edited"})
	defer s.Close()
	ctx := context.Background()

	initial := postReply(t, mux, conv.ID, map[string]any{"message": "U1 original"})
	if initial.Code != http.StatusOK {
		t.Fatalf("initial reply status=%d body=%s", initial.Code, initial.Body.String())
	}

	rangeAllReader, ok := s.Messages().(interface {
		GetRangeAll(context.Context, models.ConversationID, int64, int64) ([]*models.Message, error)
	})
	if !ok {
		t.Fatal("message store missing GetRangeAll")
	}
	before, err := rangeAllReader.GetRangeAll(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 2 {
		t.Fatalf("before edit messages=%d want=2", len(before))
	}
	userID := before[0].ID

	edited := postReply(t, mux, conv.ID, map[string]any{
		"edit_message_id": string(userID),
		"message":         "U1 edited",
	})
	if edited.Code != http.StatusOK {
		t.Fatalf("edit reply status=%d body=%s", edited.Code, edited.Body.String())
	}

	active, err := s.Messages().GetRange(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 2 {
		t.Fatalf("active messages=%d want=2", len(active))
	}
	if got := messageText(active[0]); got != "U1 edited" {
		t.Fatalf("edited user text=%q want=%q", got, "U1 edited")
	}
	if active[0].Version != 2 || active[1].Version != 2 {
		t.Fatalf("active versions got=(%d,%d) want=(2,2)", active[0].Version, active[1].Version)
	}

	var historyPayload struct {
		MessageID      string `json:"message_id"`
		CurrentMessage struct {
			Parts []models.MessagePart `json:"Parts"`
		} `json:"current_message"`
		HistoryVersions []struct {
			Parts []models.MessagePart `json:"parts"`
		} `json:"history_versions"`
	}
	status := getJSON(t, mux, "/conversations/"+string(conv.ID)+"/messages/"+string(userID)+"/history", &historyPayload)
	if status != http.StatusOK {
		t.Fatalf("history status=%d", status)
	}
	if historyPayload.MessageID != string(userID) {
		t.Fatalf("history message_id=%q want=%q", historyPayload.MessageID, userID)
	}
	if len(historyPayload.HistoryVersions) != 1 {
		t.Fatalf("history versions=%d want=1", len(historyPayload.HistoryVersions))
	}
	if got := messageText(&models.Message{Parts: historyPayload.HistoryVersions[0].Parts}); got != "U1 original" {
		t.Fatalf("history snapshot text=%q want=%q", got, "U1 original")
	}
	if got := messageText(&models.Message{Parts: historyPayload.CurrentMessage.Parts}); got != "U1 edited" {
		t.Fatalf("history current text=%q want=%q", got, "U1 edited")
	}

	histories := client.historiesSnapshot()
	if len(histories) != 2 {
		t.Fatalf("model call count=%d want=2", len(histories))
	}
	if len(histories[1]) != 1 || histories[1][0] != "U1 edited" {
		t.Fatalf("edited call history=%v want [U1 edited]", histories[1])
	}
}

func TestTimelineIncludeArchivedReturnsSupersededBranchRows(t *testing.T) {
	s, _, mux, conv := setupBranchingHandler(t, []string{"A1", "A1-edited"})
	defer s.Close()
	ctx := context.Background()

	initial := postReply(t, mux, conv.ID, map[string]any{"message": "U1 original"})
	if initial.Code != http.StatusOK {
		t.Fatalf("initial status=%d body=%s", initial.Code, initial.Body.String())
	}

	rangeAllReader, ok := s.Messages().(interface {
		GetRangeAll(context.Context, models.ConversationID, int64, int64) ([]*models.Message, error)
	})
	if !ok {
		t.Fatal("message store missing GetRangeAll")
	}
	msgs, err := rangeAllReader.GetRangeAll(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	userID := msgs[0].ID

	editResp := postReply(t, mux, conv.ID, map[string]any{
		"edit_message_id": string(userID),
		"message":         "U1 edited",
	})
	if editResp.Code != http.StatusOK {
		t.Fatalf("edit status=%d body=%s", editResp.Code, editResp.Body.String())
	}

	var activeTimeline []map[string]any
	activeStatus := getJSON(t, mux, "/conversations/"+string(conv.ID)+"/timeline", &activeTimeline)
	if activeStatus != http.StatusOK {
		t.Fatalf("active timeline status=%d", activeStatus)
	}

	var fullTimeline []map[string]any
	fullStatus := getJSON(t, mux, "/conversations/"+string(conv.ID)+"/timeline?include_archived=true", &fullTimeline)
	if fullStatus != http.StatusOK {
		t.Fatalf("full timeline status=%d", fullStatus)
	}

	if len(fullTimeline) <= len(activeTimeline) {
		t.Fatalf("include_archived timeline should be larger: active=%d full=%d", len(activeTimeline), len(fullTimeline))
	}

	foundArchivedMessage := false
	for _, item := range fullTimeline {
		if item["type"] != "message" {
			continue
		}
		msg, _ := item["message"].(map[string]any)
		if archived, ok := msg["archived"].(bool); ok && archived {
			foundArchivedMessage = true
			break
		}
		if archived, ok := msg["Archived"].(bool); ok && archived {
			foundArchivedMessage = true
			break
		}
	}
	if !foundArchivedMessage {
		t.Fatalf("expected at least one archived message in include_archived timeline")
	}
}

func TestReplyBranchValidationAndVersionProgression(t *testing.T) {
	s, _, mux, conv := setupBranchingHandler(t, []string{"A1", "A2", "A3"})
	defer s.Close()
	ctx := context.Background()

	initial := postReply(t, mux, conv.ID, map[string]any{"message": "U1"})
	if initial.Code != http.StatusOK {
		t.Fatalf("initial status=%d body=%s", initial.Code, initial.Body.String())
	}

	rangeAllReader, ok := s.Messages().(interface {
		GetRangeAll(context.Context, models.ConversationID, int64, int64) ([]*models.Message, error)
	})
	if !ok {
		t.Fatal("message store missing GetRangeAll")
	}
	before, err := rangeAllReader.GetRangeAll(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	userID := before[0].ID
	assistantID := before[1].ID

	invalidBoth := postReply(t, mux, conv.ID, map[string]any{
		"retry_message_id": string(userID),
		"edit_message_id":  string(userID),
	})
	if invalidBoth.Code != http.StatusBadRequest {
		t.Fatalf("both ids status=%d want=400 body=%s", invalidBoth.Code, invalidBoth.Body.String())
	}

	invalidRetryWithMessage := postReply(t, mux, conv.ID, map[string]any{
		"retry_message_id": string(userID),
		"message":          "should fail",
	})
	if invalidRetryWithMessage.Code != http.StatusBadRequest {
		t.Fatalf("retry with message status=%d want=400 body=%s", invalidRetryWithMessage.Code, invalidRetryWithMessage.Body.String())
	}

	invalidRetryAssistant := postReply(t, mux, conv.ID, map[string]any{
		"retry_message_id": string(assistantID),
	})
	if invalidRetryAssistant.Code != http.StatusBadRequest {
		t.Fatalf("retry assistant status=%d want=400 body=%s", invalidRetryAssistant.Code, invalidRetryAssistant.Body.String())
	}

	edit := postReply(t, mux, conv.ID, map[string]any{
		"edit_message_id": string(userID),
		"message":         "U1-v2",
	})
	if edit.Code != http.StatusOK {
		t.Fatalf("edit status=%d body=%s", edit.Code, edit.Body.String())
	}

	retry := postReply(t, mux, conv.ID, map[string]any{
		"retry_message_id": string(userID),
	})
	if retry.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s", retry.Code, retry.Body.String())
	}

	active, err := s.Messages().GetRange(ctx, conv.ID, 1, 999999)
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 2 {
		t.Fatalf("active messages=%d want=2", len(active))
	}
	if active[0].Version != 3 || active[1].Version != 3 {
		t.Fatalf("final versions got=(%d,%d) want=(3,3)", active[0].Version, active[1].Version)
	}
}
