package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"loop/models"
	"loop/store/sqlite"
)

func TestConversationCheckpointCreateRestoreAndUndoEndpoints(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	trackedPath := filepath.Join(repo, "tracked.txt")
	if err := os.WriteFile(trackedPath, []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write base tracked: %v", err)
	}
	runGitOrFatal(t, ctx, repo, "add", "tracked.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	storeDB, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storeDB.Close()

	ws := &models.Workspace{
		ID:                "ws-checkpoints",
		Name:              "Checkpoints",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := storeDB.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-checkpoints",
		WorkspaceID: ws.ID,
		Title:       "Checkpoint API",
	}
	if err := storeDB.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	handler := NewConversationHandler(storeDB, nil, nil)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	writeTracked := func(content string) {
		t.Helper()
		if err := os.WriteFile(trackedPath, []byte(content), 0o644); err != nil {
			t.Fatalf("write tracked %q: %v", content, err)
		}
	}

	createCheckpoint := func(label string) models.Checkpoint {
		t.Helper()
		body := bytes.NewBufferString(`{"label":"` + label + `"}`)
		req := httptest.NewRequest(http.MethodPost, "/conversations/conv-checkpoints/checkpoints", body)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create checkpoint status=%d body=%s", rec.Code, rec.Body.String())
		}
		var cp models.Checkpoint
		if err := json.Unmarshal(rec.Body.Bytes(), &cp); err != nil {
			t.Fatalf("decode checkpoint response: %v", err)
		}
		if cp.ID == "" || cp.CommitID == "" {
			t.Fatalf("checkpoint response missing id/commit: %+v", cp)
		}
		return cp
	}

	writeTracked("state-1\n")
	cp1 := createCheckpoint("state-1")

	writeTracked("state-2\n")
	cp2 := createCheckpoint("state-2")

	writeTracked("state-3\n")
	restoreReq := httptest.NewRequest(http.MethodPost, "/conversations/conv-checkpoints/checkpoints/"+cp1.ID+"/restore", nil)
	restoreRec := httptest.NewRecorder()
	mux.ServeHTTP(restoreRec, restoreReq)
	if restoreRec.Code != http.StatusOK {
		t.Fatalf("restore checkpoint status=%d body=%s", restoreRec.Code, restoreRec.Body.String())
	}

	got, err := os.ReadFile(trackedPath)
	if err != nil {
		t.Fatalf("read tracked after restore: %v", err)
	}
	if string(got) != "state-1\n" {
		t.Fatalf("tracked after restore = %q, want %q", string(got), "state-1\n")
	}

	writeTracked("state-4\n")
	undoReq := httptest.NewRequest(http.MethodPost, "/conversations/conv-checkpoints/undo", nil)
	undoRec := httptest.NewRecorder()
	mux.ServeHTTP(undoRec, undoReq)
	if undoRec.Code != http.StatusOK {
		t.Fatalf("undo status=%d body=%s", undoRec.Code, undoRec.Body.String())
	}

	got, err = os.ReadFile(trackedPath)
	if err != nil {
		t.Fatalf("read tracked after undo: %v", err)
	}
	if string(got) != "state-2\n" {
		t.Fatalf("tracked after undo = %q, want %q", string(got), "state-2\n")
	}

	listReq := httptest.NewRequest(http.MethodGet, "/conversations/conv-checkpoints/checkpoints", nil)
	listRec := httptest.NewRecorder()
	mux.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list checkpoints status=%d body=%s", listRec.Code, listRec.Body.String())
	}

	var listed []models.Checkpoint
	if err := json.Unmarshal(listRec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode checkpoint list: %v", err)
	}
	for _, cp := range listed {
		if cp.ID == cp2.ID {
			t.Fatalf("undo should remove latest checkpoint %s from stack", cp2.ID)
		}
	}
}

func runGitOrFatal(t *testing.T, ctx context.Context, repo string, args ...string) {
	t.Helper()
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v (%s)", args, err, string(out))
	}
}
