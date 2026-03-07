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
	"slices"
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

func TestConversationApplyPatchEndpointRevertsAddedDeletedAndUpdatedFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	trackedPath := filepath.Join(repo, "tracked.txt")
	deletedPath := filepath.Join(repo, "deleted.txt")
	addedPath := filepath.Join(repo, "added.txt")
	if err := os.WriteFile(trackedPath, []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write tracked: %v", err)
	}
	if err := os.WriteFile(deletedPath, []byte("restore me\n"), 0o644); err != nil {
		t.Fatalf("write deleted: %v", err)
	}
	runGitOrFatal(t, ctx, repo, "add", "tracked.txt", "deleted.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	storeDB, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storeDB.Close()

	ws := &models.Workspace{
		ID:                "ws-apply-patch",
		Name:              "ApplyPatch",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := storeDB.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-apply-patch",
		WorkspaceID: ws.ID,
		Title:       "Apply Patch API",
	}
	if err := storeDB.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	handler := NewConversationHandler(storeDB, nil, nil)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	cpReq := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch/checkpoints", bytes.NewBufferString(`{"label":"before-turn"}`))
	cpRec := httptest.NewRecorder()
	mux.ServeHTTP(cpRec, cpReq)
	if cpRec.Code != http.StatusCreated {
		t.Fatalf("create checkpoint status=%d body=%s", cpRec.Code, cpRec.Body.String())
	}
	var cp models.Checkpoint
	if err := json.Unmarshal(cpRec.Body.Bytes(), &cp); err != nil {
		t.Fatalf("decode checkpoint response: %v", err)
	}

	if err := os.WriteFile(trackedPath, []byte("changed\n"), 0o644); err != nil {
		t.Fatalf("write changed tracked: %v", err)
	}
	if err := os.Remove(deletedPath); err != nil {
		t.Fatalf("remove deleted.txt: %v", err)
	}
	if err := os.WriteFile(addedPath, []byte("new file\n"), 0o644); err != nil {
		t.Fatalf("write added.txt: %v", err)
	}

	body, err := json.Marshal(map[string]any{
		"message":          "System: revert files",
		"baseCheckpointId": cp.ID,
		"files": []map[string]any{
			{
				"action": "Add",
				"path":   "added.txt",
			},
			{
				"action": "Delete",
				"path":   "deleted.txt",
			},
			{
				"action": "Update",
				"path":   "tracked.txt",
				"hunks": []map[string]any{
					{
						"header": "@@ -1,1 +1,1 @@",
						"lines": []map[string]any{
							{"type": "remove", "text": "-base"},
							{"type": "add", "text": "+changed"},
						},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal apply patch request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch/apply-patch", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("apply patch status=%d body=%s", rec.Code, rec.Body.String())
	}

	trackedContent, err := os.ReadFile(trackedPath)
	if err != nil {
		t.Fatalf("read tracked after revert: %v", err)
	}
	if string(trackedContent) != "base\n" {
		t.Fatalf("tracked after revert = %q, want %q", string(trackedContent), "base\n")
	}

	deletedContent, err := os.ReadFile(deletedPath)
	if err != nil {
		t.Fatalf("read deleted after revert: %v", err)
	}
	if string(deletedContent) != "restore me\n" {
		t.Fatalf("deleted after revert = %q, want %q", string(deletedContent), "restore me\n")
	}

	if _, err := os.Stat(addedPath); !os.IsNotExist(err) {
		t.Fatalf("added.txt should be removed, stat err=%v", err)
	}
}

func TestConversationApplyPatchEndpointRevertsAddedFileWhenPayloadIncludesHunks(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	trackedPath := filepath.Join(repo, "tracked.txt")
	addedPath := filepath.Join(repo, "added.txt")
	if err := os.WriteFile(trackedPath, []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write tracked: %v", err)
	}
	runGitOrFatal(t, ctx, repo, "add", "tracked.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	storeDB, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storeDB.Close()

	ws := &models.Workspace{
		ID:                "ws-apply-patch-add-hunks",
		Name:              "ApplyPatchAddHunks",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := storeDB.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-apply-patch-add-hunks",
		WorkspaceID: ws.ID,
		Title:       "Apply Patch Add Hunks API",
	}
	if err := storeDB.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	handler := NewConversationHandler(storeDB, nil, nil)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	if err := os.WriteFile(addedPath, []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write added file: %v", err)
	}

	body, err := json.Marshal(map[string]any{
		"message": "System: revert added file",
		"files": []map[string]any{
			{
				"action": "Add",
				"path":   "added.txt",
				"hunks": []map[string]any{
					{
						"header": "@@ -1,0 +1,1 @@",
						"lines": []map[string]any{
							{"type": "add", "text": "+hello"},
						},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal apply patch request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-add-hunks/apply-patch", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("apply patch status=%d body=%s", rec.Code, rec.Body.String())
	}

	if _, err := os.Stat(addedPath); !os.IsNotExist(err) {
		t.Fatalf("added.txt should be removed, stat err=%v", err)
	}
}

func TestConversationApplyPatchEndpointSelectivelyRevertsChosenFilesOnlyAndEmitsUIEvent(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	fileA := filepath.Join(repo, "a.txt")
	fileB := filepath.Join(repo, "b.txt")
	deletedPath := filepath.Join(repo, "deleted.txt")
	oldPath := filepath.Join(repo, "old-name.txt")
	newPath := filepath.Join(repo, "new-name.txt")
	addedPath := filepath.Join(repo, "added.txt")

	write := func(path string, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	write(fileA, "alpha\n")
	write(fileB, "beta\n")
	write(deletedPath, "restore me\n")
	write(oldPath, "old line\n")
	runGitOrFatal(t, ctx, repo, "add", "a.txt", "b.txt", "deleted.txt", "old-name.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	storeDB, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storeDB.Close()

	ws := &models.Workspace{
		ID:                "ws-apply-patch-selective",
		Name:              "ApplyPatchSelective",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := storeDB.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-apply-patch-selective",
		WorkspaceID: ws.ID,
		Title:       "Apply Patch Selective",
	}
	if err := storeDB.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	handler := NewConversationHandler(storeDB, nil, nil)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	cpReq := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-selective/checkpoints", bytes.NewBufferString(`{"label":"before-turn"}`))
	cpRec := httptest.NewRecorder()
	mux.ServeHTTP(cpRec, cpReq)
	if cpRec.Code != http.StatusCreated {
		t.Fatalf("create checkpoint status=%d body=%s", cpRec.Code, cpRec.Body.String())
	}
	var cp models.Checkpoint
	if err := json.Unmarshal(cpRec.Body.Bytes(), &cp); err != nil {
		t.Fatalf("decode checkpoint response: %v", err)
	}

	write(fileA, "alpha changed\n")
	write(fileB, "beta changed\n")
	if err := os.Remove(deletedPath); err != nil {
		t.Fatalf("remove deleted path: %v", err)
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		t.Fatalf("rename old->new: %v", err)
	}
	write(newPath, "old line\nnew line\n")
	write(addedPath, "brand new\n")

	body, err := json.Marshal(map[string]any{
		"message":          "System: The user manually reverted changes to selected files.",
		"baseCheckpointId": cp.ID,
		"patchId":          "tool-calls:conv-apply-patch-selective:call-1,call-2",
		"files": []map[string]any{
			{
				"action": "Update",
				"path":   "a.txt",
				"hunks": []map[string]any{
					{
						"header": "@@ -1,1 +1,1 @@",
						"lines": []map[string]any{
							{"type": "remove", "text": "-alpha"},
							{"type": "add", "text": "+alpha changed"},
						},
					},
				},
			},
			{
				"action": "Delete",
				"path":   "deleted.txt",
			},
			{
				"action":       "Move",
				"path":         "new-name.txt",
				"previousPath": "old-name.txt",
				"hunks": []map[string]any{
					{
						"header": "@@ -1,1 +1,2 @@",
						"lines": []map[string]any{
							{"type": "context", "text": " old line"},
							{"type": "add", "text": "+new line"},
						},
					},
				},
			},
			{
				"action": "Add",
				"path":   "added.txt",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal apply patch request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-selective/apply-patch", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("apply patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	var applyResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &applyResp); err != nil {
		t.Fatalf("decode apply patch response: %v", err)
	}
	if got := applyResp["success"]; got != true {
		t.Fatalf("apply patch response success = %v, want true", got)
	}
	workspaceChange, ok := applyResp["workspace_change"].(map[string]any)
	if !ok {
		t.Fatalf("apply patch response workspace_change type = %T, want object", applyResp["workspace_change"])
	}
	if got := workspaceChange["kind"]; got != string(models.UIEventKindWorkspaceChangesApplied) {
		t.Fatalf("apply patch response workspace_change.kind = %v, want %s", got, models.UIEventKindWorkspaceChangesApplied)
	}
	if got := workspaceChange["reason"]; got != "manual_revert" {
		t.Fatalf("apply patch response workspace_change.reason = %v, want manual_revert", got)
	}
	if got := workspaceChange["patch_id"]; got != "tool-calls:conv-apply-patch-selective:call-1,call-2" {
		t.Fatalf("apply patch response workspace_change.patch_id = %v, want patch id", got)
	}
	if got := workspaceChange["base_checkpoint_id"]; got != cp.ID {
		t.Fatalf("apply patch response workspace_change.base_checkpoint_id = %v, want %s", got, cp.ID)
	}
	if got, ok := workspaceChange["checkpoint_id"].(string); !ok || got == "" {
		t.Fatalf("apply patch response workspace_change.checkpoint_id = %v, want non-empty string", workspaceChange["checkpoint_id"])
	}
	if got := workspaceChange["file_count"]; got != float64(4) {
		t.Fatalf("apply patch response workspace_change.file_count = %v, want 4", got)
	}
	filePaths, ok := workspaceChange["file_paths"].([]any)
	if !ok {
		t.Fatalf("apply patch response workspace_change.file_paths type = %T, want []any", workspaceChange["file_paths"])
	}
	if len(filePaths) != 4 {
		t.Fatalf("apply patch response workspace_change.file_paths len = %d, want 4", len(filePaths))
	}

	gotA, err := os.ReadFile(fileA)
	if err != nil {
		t.Fatalf("read a.txt: %v", err)
	}
	if string(gotA) != "alpha\n" {
		t.Fatalf("a.txt after selective revert = %q, want %q", string(gotA), "alpha\n")
	}

	gotB, err := os.ReadFile(fileB)
	if err != nil {
		t.Fatalf("read b.txt: %v", err)
	}
	if string(gotB) != "beta changed\n" {
		t.Fatalf("b.txt after selective revert = %q, want %q", string(gotB), "beta changed\n")
	}

	gotDeleted, err := os.ReadFile(deletedPath)
	if err != nil {
		t.Fatalf("read deleted.txt: %v", err)
	}
	if string(gotDeleted) != "restore me\n" {
		t.Fatalf("deleted.txt after selective revert = %q, want %q", string(gotDeleted), "restore me\n")
	}

	gotOld, err := os.ReadFile(oldPath)
	if err != nil {
		t.Fatalf("read old-name.txt: %v", err)
	}
	if string(gotOld) != "old line\n" {
		t.Fatalf("old-name.txt after selective revert = %q, want %q", string(gotOld), "old line\n")
	}
	if _, err := os.Stat(newPath); !os.IsNotExist(err) {
		t.Fatalf("new-name.txt should be removed after selective revert, stat err=%v", err)
	}
	if _, err := os.Stat(addedPath); !os.IsNotExist(err) {
		t.Fatalf("added.txt should be removed after selective revert, stat err=%v", err)
	}

	uiEvents, err := storeDB.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("get ui events: %v", err)
	}
	var applyCheckpointID string
	found := false
	for _, evt := range uiEvents {
		if evt.Kind != models.UIEventKindWorkspaceChangesApplied {
			continue
		}
		found = true
		if got := evt.Metadata["reason"]; got != "manual_revert" {
			t.Fatalf("workspace change event reason = %v, want manual_revert", got)
		}
		if got := evt.Metadata["patch_id"]; got != "tool-calls:conv-apply-patch-selective:call-1,call-2" {
			t.Fatalf("workspace change event patch_id = %v, want patch id", got)
		}
		if got := evt.Metadata["base_checkpoint_id"]; got != cp.ID {
			t.Fatalf("workspace change event base_checkpoint_id = %v, want %s", got, cp.ID)
		}
		if got, ok := evt.Metadata["checkpoint_id"].(string); !ok || got == "" {
			t.Fatalf("workspace change event checkpoint_id = %v, want non-empty string", evt.Metadata["checkpoint_id"])
		} else {
			applyCheckpointID = got
		}
		filePaths, ok := evt.Metadata["file_paths"].([]any)
		if !ok {
			t.Fatalf("workspace change event file_paths type = %T, want []any", evt.Metadata["file_paths"])
		}
		var gotPaths []string
		for _, item := range filePaths {
			gotPaths = append(gotPaths, item.(string))
		}
		wantPaths := []string{"a.txt", "deleted.txt", "new-name.txt", "added.txt"}
		if !slices.Equal(gotPaths, wantPaths) {
			t.Fatalf("workspace change event file_paths = %v, want %v", gotPaths, wantPaths)
		}
	}
	if !found {
		t.Fatalf("expected workspace_changes_applied event, events=%+v", uiEvents)
	}

	checkpointsAfterRevert, err := storeDB.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list checkpoints after selective revert: %v", err)
	}
	if len(checkpointsAfterRevert) != 2 {
		t.Fatalf("checkpoint count after selective revert = %d, want 2", len(checkpointsAfterRevert))
	}
	if checkpointsAfterRevert[0].ID != applyCheckpointID {
		t.Fatalf("latest checkpoint after selective revert = %s, want %s", checkpointsAfterRevert[0].ID, applyCheckpointID)
	}

	undoReq := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-selective/undo", nil)
	undoRec := httptest.NewRecorder()
	mux.ServeHTTP(undoRec, undoReq)
	if undoRec.Code != http.StatusOK {
		t.Fatalf("undo after selective revert status=%d body=%s", undoRec.Code, undoRec.Body.String())
	}

	gotA, err = os.ReadFile(fileA)
	if err != nil {
		t.Fatalf("read a.txt after undoing selective revert: %v", err)
	}
	if string(gotA) != "alpha changed\n" {
		t.Fatalf("a.txt after undoing selective revert = %q, want %q", string(gotA), "alpha changed\n")
	}

	gotB, err = os.ReadFile(fileB)
	if err != nil {
		t.Fatalf("read b.txt after undoing selective revert: %v", err)
	}
	if string(gotB) != "beta changed\n" {
		t.Fatalf("b.txt after undoing selective revert = %q, want %q", string(gotB), "beta changed\n")
	}

	if _, err := os.Stat(deletedPath); !os.IsNotExist(err) {
		t.Fatalf("deleted.txt should be absent after undoing selective revert, stat err=%v", err)
	}

	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old-name.txt should be absent after undoing selective revert, stat err=%v", err)
	}
	gotNew, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatalf("read new-name.txt after undoing selective revert: %v", err)
	}
	if string(gotNew) != "old line\nnew line\n" {
		t.Fatalf("new-name.txt after undoing selective revert = %q, want %q", string(gotNew), "old line\\nnew line\\n")
	}

	gotAdded, err := os.ReadFile(addedPath)
	if err != nil {
		t.Fatalf("read added.txt after undoing selective revert: %v", err)
	}
	if string(gotAdded) != "brand new\n" {
		t.Fatalf("added.txt after undoing selective revert = %q, want %q", string(gotAdded), "brand new\n")
	}
}

func TestConversationApplyPatchEndpointRestoresDeletedFileFromRequestedCheckpoint(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	versionedPath := filepath.Join(repo, "deleted.txt")
	if err := os.WriteFile(versionedPath, []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write seed file: %v", err)
	}
	runGitOrFatal(t, ctx, repo, "add", "deleted.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	storeDB, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storeDB.Close()

	ws := &models.Workspace{
		ID:                "ws-apply-patch-targeted",
		Name:              "ApplyPatchTargeted",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := storeDB.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-apply-patch-targeted",
		WorkspaceID: ws.ID,
		Title:       "Apply Patch Targeted Checkpoint",
	}
	if err := storeDB.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	handler := NewConversationHandler(storeDB, nil, nil)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	createCheckpoint := func(label string) models.Checkpoint {
		t.Helper()
		body := bytes.NewBufferString(`{"label":"` + label + `"}`)
		req := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-targeted/checkpoints", body)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create checkpoint status=%d body=%s", rec.Code, rec.Body.String())
		}
		var cp models.Checkpoint
		if err := json.Unmarshal(rec.Body.Bytes(), &cp); err != nil {
			t.Fatalf("decode checkpoint response: %v", err)
		}
		return cp
	}

	restoreDeletedFrom := func(checkpointID string) {
		t.Helper()
		body, err := json.Marshal(map[string]any{
			"message":          "System: restore deleted file from requested checkpoint",
			"baseCheckpointId": checkpointID,
			"files": []map[string]any{
				{
					"action": "Delete",
					"path":   "deleted.txt",
				},
			},
		})
		if err != nil {
			t.Fatalf("marshal apply patch request: %v", err)
		}

		req := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-targeted/apply-patch", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("apply patch status=%d body=%s", rec.Code, rec.Body.String())
		}
	}

	if err := os.WriteFile(versionedPath, []byte("version-one\n"), 0o644); err != nil {
		t.Fatalf("write version one: %v", err)
	}
	cp1 := createCheckpoint("version-one")

	if err := os.WriteFile(versionedPath, []byte("version-two\n"), 0o644); err != nil {
		t.Fatalf("write version two: %v", err)
	}
	cp2 := createCheckpoint("version-two")

	if err := os.Remove(versionedPath); err != nil {
		t.Fatalf("delete file before restore: %v", err)
	}
	restoreDeletedFrom(cp1.ID)

	got, err := os.ReadFile(versionedPath)
	if err != nil {
		t.Fatalf("read restored file from cp1: %v", err)
	}
	if string(got) != "version-one\n" {
		t.Fatalf("restored contents from cp1 = %q, want %q", string(got), "version-one\n")
	}

	if err := os.Remove(versionedPath); err != nil {
		t.Fatalf("delete file before restore from cp2: %v", err)
	}
	restoreDeletedFrom(cp2.ID)

	got, err = os.ReadFile(versionedPath)
	if err != nil {
		t.Fatalf("read restored file from cp2: %v", err)
	}
	if string(got) != "version-two\n" {
		t.Fatalf("restored contents from cp2 = %q, want %q", string(got), "version-two\n")
	}
}

func TestConversationApplyPatchEndpointLayeredPartialRevertsUndoOnlyLatestSubset(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	fileA := filepath.Join(repo, "a.txt")
	fileB := filepath.Join(repo, "b.txt")
	fileC := filepath.Join(repo, "c.txt")

	write := func(path string, content string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	write(fileA, "alpha\n")
	write(fileB, "beta\n")
	write(fileC, "gamma\n")
	runGitOrFatal(t, ctx, repo, "add", "a.txt", "b.txt", "c.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	storeDB, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storeDB.Close()

	ws := &models.Workspace{
		ID:                "ws-apply-patch-layered-reverts",
		Name:              "ApplyPatchLayeredReverts",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := storeDB.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-apply-patch-layered-reverts",
		WorkspaceID: ws.ID,
		Title:       "Apply Patch Layered Reverts",
	}
	if err := storeDB.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	handler := NewConversationHandler(storeDB, nil, nil)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	var sourceCheckpoint models.Checkpoint

	createCheckpoint := func(label string) models.Checkpoint {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-layered-reverts/checkpoints", bytes.NewBufferString(`{"label":"`+label+`"}`))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create checkpoint status=%d body=%s", rec.Code, rec.Body.String())
		}
		var cp models.Checkpoint
		if err := json.Unmarshal(rec.Body.Bytes(), &cp); err != nil {
			t.Fatalf("decode checkpoint response: %v", err)
		}
		return cp
	}

	applySelectiveRevert := func(files []map[string]any) string {
		t.Helper()
		body, err := json.Marshal(map[string]any{
			"message":          "System: The user manually reverted changes to selected files.",
			"baseCheckpointId": sourceCheckpoint.ID,
			"patchId":          "tool-calls:conv-apply-patch-layered-reverts:call-a,call-b,call-c",
			"files":            files,
		})
		if err != nil {
			t.Fatalf("marshal apply patch request: %v", err)
		}

		req := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-layered-reverts/apply-patch", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("apply patch status=%d body=%s", rec.Code, rec.Body.String())
		}

		var resp map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode apply patch response: %v", err)
		}
		workspaceChange, ok := resp["workspace_change"].(map[string]any)
		if !ok {
			t.Fatalf("workspace_change type = %T, want object", resp["workspace_change"])
		}
		checkpointID, ok := workspaceChange["checkpoint_id"].(string)
		if !ok || checkpointID == "" {
			t.Fatalf("workspace_change.checkpoint_id = %v, want non-empty string", workspaceChange["checkpoint_id"])
		}
		return checkpointID
	}

	read := func(path string) string {
		t.Helper()
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		return string(got)
	}

	sourceCheckpoint = createCheckpoint("before-turn")

	write(fileA, "alpha changed\n")
	write(fileB, "beta changed\n")
	write(fileC, "gamma changed\n")

	revertCheckpoint1 := applySelectiveRevert([]map[string]any{
		{
			"action": "Update",
			"path":   "a.txt",
			"hunks": []map[string]any{
				{
					"header": "@@ -1,1 +1,1 @@",
					"lines": []map[string]any{
						{"type": "remove", "text": "-alpha"},
						{"type": "add", "text": "+alpha changed"},
					},
				},
			},
		},
		{
			"action": "Update",
			"path":   "b.txt",
			"hunks": []map[string]any{
				{
					"header": "@@ -1,1 +1,1 @@",
					"lines": []map[string]any{
						{"type": "remove", "text": "-beta"},
						{"type": "add", "text": "+beta changed"},
					},
				},
			},
		},
	})

	if got := read(fileA); got != "alpha\n" {
		t.Fatalf("a.txt after first partial revert = %q, want %q", got, "alpha\n")
	}
	if got := read(fileB); got != "beta\n" {
		t.Fatalf("b.txt after first partial revert = %q, want %q", got, "beta\n")
	}
	if got := read(fileC); got != "gamma changed\n" {
		t.Fatalf("c.txt after first partial revert = %q, want %q", got, "gamma changed\n")
	}

	revertCheckpoint2 := applySelectiveRevert([]map[string]any{
		{
			"action": "Update",
			"path":   "c.txt",
			"hunks": []map[string]any{
				{
					"header": "@@ -1,1 +1,1 @@",
					"lines": []map[string]any{
						{"type": "remove", "text": "-gamma"},
						{"type": "add", "text": "+gamma changed"},
					},
				},
			},
		},
	})

	if got := read(fileC); got != "gamma\n" {
		t.Fatalf("c.txt after second partial revert = %q, want %q", got, "gamma\n")
	}

	undoReq := httptest.NewRequest(http.MethodPost, "/conversations/conv-apply-patch-layered-reverts/undo", nil)
	undoRec := httptest.NewRecorder()
	mux.ServeHTTP(undoRec, undoReq)
	if undoRec.Code != http.StatusOK {
		t.Fatalf("undo after layered revert status=%d body=%s", undoRec.Code, undoRec.Body.String())
	}

	if got := read(fileA); got != "alpha\n" {
		t.Fatalf("a.txt after undoing latest revert = %q, want %q", got, "alpha\n")
	}
	if got := read(fileB); got != "beta\n" {
		t.Fatalf("b.txt after undoing latest revert = %q, want %q", got, "beta\n")
	}
	if got := read(fileC); got != "gamma changed\n" {
		t.Fatalf("c.txt after undoing latest revert = %q, want %q", got, "gamma changed\n")
	}

	checkpoints, err := storeDB.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list checkpoints: %v", err)
	}
	gotCheckpointIDs := make([]string, 0, len(checkpoints))
	for _, cp := range checkpoints {
		gotCheckpointIDs = append(gotCheckpointIDs, cp.ID)
	}
	wantCheckpointIDs := []string{revertCheckpoint1, sourceCheckpoint.ID}
	if !slices.Equal(gotCheckpointIDs, wantCheckpointIDs) {
		t.Fatalf("checkpoints after undo = %v, want %v", gotCheckpointIDs, wantCheckpointIDs)
	}
	for _, checkpointID := range gotCheckpointIDs {
		if checkpointID == revertCheckpoint2 {
			t.Fatalf("latest revert checkpoint %s should be removed after undo", revertCheckpoint2)
		}
	}

	uiEvents, err := storeDB.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("get ui events: %v", err)
	}
	var revertEventPaths [][]string
	var undoCheckpointIDs []string
	for _, evt := range uiEvents {
		switch evt.Kind {
		case models.UIEventKindWorkspaceChangesApplied:
			rawPaths, ok := evt.Metadata["file_paths"].([]any)
			if !ok {
				t.Fatalf("workspace change event file_paths type = %T, want []any", evt.Metadata["file_paths"])
			}
			paths := make([]string, 0, len(rawPaths))
			for _, item := range rawPaths {
				paths = append(paths, item.(string))
			}
			revertEventPaths = append(revertEventPaths, paths)
		case models.UIEventKindCheckpointRestored:
			if reason, _ := evt.Metadata["reason"].(string); reason == "undo_latest" {
				if checkpointID, _ := evt.Metadata["checkpoint_id"].(string); checkpointID != "" {
					undoCheckpointIDs = append(undoCheckpointIDs, checkpointID)
				}
			}
		}
	}
	if len(revertEventPaths) != 2 {
		t.Fatalf("workspace change event count = %d, want 2", len(revertEventPaths))
	}
	if !slices.Equal(revertEventPaths[0], []string{"a.txt", "b.txt"}) {
		t.Fatalf("first revert event paths = %v, want %v", revertEventPaths[0], []string{"a.txt", "b.txt"})
	}
	if !slices.Equal(revertEventPaths[1], []string{"c.txt"}) {
		t.Fatalf("second revert event paths = %v, want %v", revertEventPaths[1], []string{"c.txt"})
	}
	if !slices.Equal(undoCheckpointIDs, []string{revertCheckpoint2}) {
		t.Fatalf("undo checkpoint restore ids = %v, want [%s]", undoCheckpointIDs, revertCheckpoint2)
	}
}

func TestConversationUndoEndpointRestoresCheckpointStackAndUntrackedState(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	trackedPath := filepath.Join(repo, "tracked.txt")
	preservedPath := filepath.Join(repo, "keep.txt")
	preservedDirFile := filepath.Join(repo, "cache", "seed.txt")
	if err := os.MkdirAll(filepath.Dir(preservedDirFile), 0o755); err != nil {
		t.Fatalf("mkdir preserved dir: %v", err)
	}
	if err := os.WriteFile(trackedPath, []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write base tracked: %v", err)
	}
	if err := os.WriteFile(preservedPath, []byte("keep-base\n"), 0o644); err != nil {
		t.Fatalf("write preserved file: %v", err)
	}
	if err := os.WriteFile(preservedDirFile, []byte("cache-base\n"), 0o644); err != nil {
		t.Fatalf("write preserved dir file: %v", err)
	}
	runGitOrFatal(t, ctx, repo, "add", "tracked.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	storeDB, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storeDB.Close()

	ws := &models.Workspace{
		ID:                "ws-undo-stack",
		Name:              "UndoStack",
		RootPath:          repo,
		CanonicalRootPath: repo,
	}
	if err := storeDB.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-undo-stack",
		WorkspaceID: ws.ID,
		Title:       "Undo Stack API",
	}
	if err := storeDB.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	handler := NewConversationHandler(storeDB, nil, nil)
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	writeFile := func(path string, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	createCheckpoint := func(label string) models.Checkpoint {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/conversations/conv-undo-stack/checkpoints", bytes.NewBufferString(`{"label":"`+label+`"}`))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create checkpoint status=%d body=%s", rec.Code, rec.Body.String())
		}
		var cp models.Checkpoint
		if err := json.Unmarshal(rec.Body.Bytes(), &cp); err != nil {
			t.Fatalf("decode checkpoint response: %v", err)
		}
		return cp
	}

	listCheckpointIDs := func() []string {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/conversations/conv-undo-stack/checkpoints", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("list checkpoints status=%d body=%s", rec.Code, rec.Body.String())
		}
		var checkpoints []models.Checkpoint
		if err := json.Unmarshal(rec.Body.Bytes(), &checkpoints); err != nil {
			t.Fatalf("decode checkpoint list: %v", err)
		}
		ids := make([]string, 0, len(checkpoints))
		for _, cp := range checkpoints {
			ids = append(ids, cp.ID)
		}
		return ids
	}

	undo := func(expectedStatus int) models.Checkpoint {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/conversations/conv-undo-stack/undo", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != expectedStatus {
			t.Fatalf("undo status=%d body=%s", rec.Code, rec.Body.String())
		}
		if expectedStatus != http.StatusOK {
			return models.Checkpoint{}
		}
		var resp struct {
			Success    bool              `json:"success"`
			Checkpoint models.Checkpoint `json:"checkpoint"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode undo response: %v", err)
		}
		if !resp.Success {
			t.Fatalf("undo response success=false: %s", rec.Body.String())
		}
		return resp.Checkpoint
	}

	writeFile(trackedPath, "state-1\n")
	writeFile(preservedPath, "keep-state-1\n")
	writeFile(preservedDirFile, "cache-state-1\n")
	cp1 := createCheckpoint("state-1")

	writeFile(trackedPath, "state-2\n")
	writeFile(preservedPath, "keep-state-2\n")
	writeFile(preservedDirFile, "cache-state-2\n")
	cp2 := createCheckpoint("state-2")

	postCheckpointFile := filepath.Join(repo, "scratch.txt")
	postCheckpointDirFile := filepath.Join(repo, "tmp", "generated.txt")
	writeFile(trackedPath, "state-3\n")
	writeFile(preservedPath, "keep-state-3\n")
	writeFile(preservedDirFile, "cache-state-3\n")
	writeFile(postCheckpointFile, "remove me\n")
	writeFile(postCheckpointDirFile, "remove dir me\n")

	undone := undo(http.StatusOK)
	if undone.ID != cp2.ID {
		t.Fatalf("first undo restored checkpoint %s, want %s", undone.ID, cp2.ID)
	}

	gotTracked, err := os.ReadFile(trackedPath)
	if err != nil {
		t.Fatalf("read tracked after first undo: %v", err)
	}
	if string(gotTracked) != "state-2\n" {
		t.Fatalf("tracked after first undo = %q, want %q", string(gotTracked), "state-2\n")
	}

	gotPreserved, err := os.ReadFile(preservedPath)
	if err != nil {
		t.Fatalf("read preserved file after first undo: %v", err)
	}
	if string(gotPreserved) != "keep-state-2\n" {
		t.Fatalf("preserved file after first undo = %q, want %q", string(gotPreserved), "keep-state-2\n")
	}

	gotPreservedDir, err := os.ReadFile(preservedDirFile)
	if err != nil {
		t.Fatalf("read preserved dir file after first undo: %v", err)
	}
	if string(gotPreservedDir) != "cache-state-2\n" {
		t.Fatalf("preserved dir file after first undo = %q, want %q", string(gotPreservedDir), "cache-state-2\n")
	}

	if _, err := os.Stat(postCheckpointFile); !os.IsNotExist(err) {
		t.Fatalf("scratch.txt should be removed after first undo, stat err=%v", err)
	}
	if _, err := os.Stat(postCheckpointDirFile); !os.IsNotExist(err) {
		t.Fatalf("tmp/generated.txt should be removed after first undo, stat err=%v", err)
	}

	if got := listCheckpointIDs(); len(got) != 1 || got[0] != cp1.ID {
		t.Fatalf("checkpoint ids after first undo = %v, want [%s]", got, cp1.ID)
	}

	secondScratch := filepath.Join(repo, "scratch-2.txt")
	writeFile(trackedPath, "state-4\n")
	writeFile(preservedPath, "keep-state-4\n")
	writeFile(preservedDirFile, "cache-state-4\n")
	writeFile(secondScratch, "remove me too\n")

	undone = undo(http.StatusOK)
	if undone.ID != cp1.ID {
		t.Fatalf("second undo restored checkpoint %s, want %s", undone.ID, cp1.ID)
	}

	gotTracked, err = os.ReadFile(trackedPath)
	if err != nil {
		t.Fatalf("read tracked after second undo: %v", err)
	}
	if string(gotTracked) != "state-1\n" {
		t.Fatalf("tracked after second undo = %q, want %q", string(gotTracked), "state-1\n")
	}

	gotPreserved, err = os.ReadFile(preservedPath)
	if err != nil {
		t.Fatalf("read preserved file after second undo: %v", err)
	}
	if string(gotPreserved) != "keep-state-1\n" {
		t.Fatalf("preserved file after second undo = %q, want %q", string(gotPreserved), "keep-state-1\n")
	}

	gotPreservedDir, err = os.ReadFile(preservedDirFile)
	if err != nil {
		t.Fatalf("read preserved dir file after second undo: %v", err)
	}
	if string(gotPreservedDir) != "cache-state-1\n" {
		t.Fatalf("preserved dir file after second undo = %q, want %q", string(gotPreservedDir), "cache-state-1\n")
	}

	if _, err := os.Stat(secondScratch); !os.IsNotExist(err) {
		t.Fatalf("scratch-2.txt should be removed after second undo, stat err=%v", err)
	}
	if got := listCheckpointIDs(); len(got) != 0 {
		t.Fatalf("checkpoint ids after second undo = %v, want empty", got)
	}

	undo(http.StatusNotFound)
}

func runGitOrFatal(t *testing.T, ctx context.Context, repo string, args ...string) {
	t.Helper()
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v (%s)", args, err, string(out))
	}
}
