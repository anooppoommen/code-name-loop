package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"loop/agent"
	"loop/models"
	"loop/store"
	"loop/store/sqlite"
)

type scriptedTurnModelClient struct {
	mu        sync.Mutex
	responses [][]agent.TurnEvent
	histories [][]*models.Message
}

func (m *scriptedTurnModelClient) StreamMessage(ctx context.Context, history []*models.Message, cfg *agent.GenerateContentConfig) <-chan agent.TurnEvent {
	if cfg != nil && cfg.Model == agent.ModelGemini3FlashPreview {
		ch := make(chan agent.TurnEvent, 1)
		ch <- agent.TurnEvent{
			Kind: agent.EventMessageDone,
			Message: &models.Message{
				Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "Generated Title"}}},
			},
		}
		close(ch)
		return ch
	}

	m.mu.Lock()
	m.histories = append(m.histories, cloneMessages(history))
	callIndex := len(m.histories) - 1
	reply := []agent.TurnEvent{{
		Kind: agent.EventMessageDone,
		Message: &models.Message{
			Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "ok"}}},
		},
	}}
	if callIndex < len(m.responses) {
		reply = m.responses[callIndex]
	}
	m.mu.Unlock()

	ch := make(chan agent.TurnEvent, len(reply))
	for _, event := range reply {
		ch <- event
	}
	close(ch)
	return ch
}

func (m *scriptedTurnModelClient) Model() string {
	return agent.ModelGemini31ProPreview
}

func (m *scriptedTurnModelClient) historiesSnapshot() [][]*models.Message {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([][]*models.Message, len(m.histories))
	for i := range m.histories {
		out[i] = cloneMessages(m.histories[i])
	}
	return out
}

func cloneMessages(history []*models.Message) []*models.Message {
	out := make([]*models.Message, 0, len(history))
	for _, msg := range history {
		if msg == nil {
			continue
		}
		cloned := *msg
		cloned.Parts = append([]models.MessagePart(nil), msg.Parts...)
		out = append(out, &cloned)
	}
	return out
}

func toolCallTurnEvent(name, callID, args string) []agent.TurnEvent {
	return []agent.TurnEvent{{
		Kind: agent.EventMessageDone,
		Message: &models.Message{
			Parts: []models.MessagePart{{
				Kind: models.PartFunctionCall,
				FunctionCall: &models.FunctionCallPart{
					CallID:   callID,
					Name:     name,
					ArgsJSON: json.RawMessage(args),
				},
			}},
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

func TestCreateConversationRejectsUnregisteredWorktreePath(t *testing.T) {
	_, mux, _, cleanup := setupConversationWorktreeHandler(t, nil)
	defer cleanup()

	reqBody := map[string]any{
		"ID":           "conv-invalid-worktree",
		"WorkspaceID":  "ws-worktree",
		"Title":        "Bad Worktree",
		"WorktreePath": filepath.Join(t.TempDir(), "not-a-worktree"),
	}
	rec := postJSONToMux(t, mux, http.MethodPost, "/conversations", reqBody)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestReplyUsesConversationWorktreePathForToolReads(t *testing.T) {
	client := &scriptedTurnModelClient{
		responses: [][]agent.TurnEvent{
			toolCallTurnEvent("read_file", "read-worktree", `{"file_path":"tracked.txt"}`),
			{{
				Kind: agent.EventMessageDone,
				Message: &models.Message{
					Parts: []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "done"}}},
				},
			}},
		},
	}
	_, mux, worktreePath, cleanup := setupConversationWorktreeHandler(t, client)
	defer cleanup()

	createBody := map[string]any{
		"ID":           "conv-worktree",
		"WorkspaceID":  "ws-worktree",
		"Title":        "Worktree Conversation",
		"WorktreePath": worktreePath,
	}
	createRec := postJSONToMux(t, mux, http.MethodPost, "/conversations", createBody)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createRec.Code, createRec.Body.String())
	}

	replyRec := postJSONToMux(t, mux, http.MethodPost, "/conversations/conv-worktree/reply", map[string]any{
		"message": "inspect worktree",
	})
	if replyRec.Code != http.StatusOK {
		t.Fatalf("reply status=%d body=%s", replyRec.Code, replyRec.Body.String())
	}

	histories := client.historiesSnapshot()
	if len(histories) != 2 {
		t.Fatalf("model call count=%d want=2", len(histories))
	}

	toolResult := historyToolResponseMap(t, histories[1], "read-worktree")
	output, _ := toolResult["output"].(string)
	if output == "" {
		t.Fatalf("tool output missing: %+v", toolResult)
	}
	if !bytes.Contains([]byte(output), []byte("worktree version")) {
		t.Fatalf("tool output=%q, want worktree contents", output)
	}
	if bytes.Contains([]byte(output), []byte("root version")) {
		t.Fatalf("tool output=%q should not contain root workspace contents", output)
	}
}

func setupConversationWorktreeHandler(t *testing.T, client agent.ModelClient) (store.Store, *http.ServeMux, string, func()) {
	t.Helper()

	rootDir := t.TempDir()
	repoPath := filepath.Join(rootDir, "repo")
	if err := os.MkdirAll(repoPath, 0o755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}

	runGit(t, repoPath, "init", "-b", "main")
	runGit(t, repoPath, "config", "user.name", "Loop Test")
	runGit(t, repoPath, "config", "user.email", "loop@example.com")

	trackedFile := filepath.Join(repoPath, "tracked.txt")
	if err := os.WriteFile(trackedFile, []byte("root version\n"), 0o644); err != nil {
		t.Fatalf("write tracked file: %v", err)
	}
	runGit(t, repoPath, "add", "tracked.txt")
	runGit(t, repoPath, "commit", "-m", "initial commit")

	worktreePath := filepath.Join(rootDir, "wt-loop-test")
	runGit(t, repoPath, "worktree", "add", "-b", "loop/test-read", worktreePath, "main")
	if err := os.WriteFile(filepath.Join(worktreePath, "tracked.txt"), []byte("worktree version\n"), 0o644); err != nil {
		t.Fatalf("write worktree file: %v", err)
	}

	dbPath := filepath.Join(rootDir, "test.db")
	s, err := sqlite.New(dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}

	ws := &models.Workspace{
		ID:                "ws-worktree",
		Name:              "Workspace",
		RootPath:          repoPath,
		CanonicalRootPath: repoPath,
	}
	if err := s.Workspaces().Create(context.Background(), ws); err != nil {
		s.Close()
		t.Fatalf("create workspace: %v", err)
	}

	mux := http.NewServeMux()
	NewConversationHandler(s, client, nil).RegisterRoutes(mux)

	return s, mux, worktreePath, func() {
		s.Close()
	}
}

func postJSONToMux(t *testing.T, mux *http.ServeMux, method, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}
