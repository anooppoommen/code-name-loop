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

func TestGitCreateWorktreeRejectsInvalidBranchName(t *testing.T) {
	_, mux, cleanup := newWorkspaceHandlerTestServer(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-1/git/worktree", bytes.NewBufferString(`{"branch":"bad branch"}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGitCreateWorktreeCreatesDefaultPathAndAppearsInStatus(t *testing.T) {
	repoPath, mux, cleanup := newWorkspaceHandlerTestServer(t)
	defer cleanup()

	oldHomeDir := homeDir
	homeDir = t.TempDir()
	defer func() {
		homeDir = oldHomeDir
	}()

	req := httptest.NewRequest(
		http.MethodPost,
		"/workspaces/ws-1/git/worktree",
		bytes.NewBufferString(`{"branch":"loop/test-worktree","base":"main"}`),
	)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var createResp struct {
		Path   string `json:"path"`
		Branch string `json:"branch"`
		Base   string `json:"base"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	wantPath := filepath.Join(homeDir, ".gemini-loop", "worktrees", filepath.Base(repoPath), "loop-test-worktree")
	if createResp.Path != wantPath {
		t.Fatalf("path=%q want=%q", createResp.Path, wantPath)
	}
	if createResp.Branch != "loop/test-worktree" {
		t.Fatalf("branch=%q", createResp.Branch)
	}
	if createResp.Base != "main" {
		t.Fatalf("base=%q", createResp.Base)
	}

	if _, err := os.Stat(createResp.Path); err != nil {
		t.Fatalf("worktree path missing: %v", err)
	}

	currentBranch := runGit(t, createResp.Path, "branch", "--show-current")
	if currentBranch != "loop/test-worktree" {
		t.Fatalf("worktree branch=%q", currentBranch)
	}

	statusReq := httptest.NewRequest(http.MethodGet, "/workspaces/ws-1/git", nil)
	statusRec := httptest.NewRecorder()
	mux.ServeHTTP(statusRec, statusReq)
	if statusRec.Code != http.StatusOK {
		t.Fatalf("status endpoint status=%d body=%s", statusRec.Code, statusRec.Body.String())
	}

	var statusResp struct {
		IsInitialized bool `json:"is_initialized"`
		HasCommits    bool `json:"has_commits"`
		Worktrees     []struct {
			Path   string `json:"path"`
			Branch string `json:"branch"`
		} `json:"worktrees"`
	}
	if err := json.Unmarshal(statusRec.Body.Bytes(), &statusResp); err != nil {
		t.Fatalf("decode status response: %v", err)
	}

	if !statusResp.IsInitialized {
		t.Fatalf("expected repository to be initialized")
	}
	if !statusResp.HasCommits {
		t.Fatalf("expected repository to report existing commits")
	}

	found := false
	normalizedWant, err := filepath.EvalSymlinks(createResp.Path)
	if err != nil {
		normalizedWant = filepath.Clean(createResp.Path)
	}
	for _, worktree := range statusResp.Worktrees {
		normalizedGot, err := filepath.EvalSymlinks(worktree.Path)
		if err != nil {
			normalizedGot = filepath.Clean(worktree.Path)
		}
		if normalizedGot == normalizedWant && worktree.Branch == createResp.Branch {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("created worktree missing from status response: %+v", statusResp.Worktrees)
	}
}

func newWorkspaceHandlerTestServer(t *testing.T) (string, *http.ServeMux, func()) {
	t.Helper()

	rootDir := t.TempDir()
	repoPath := filepath.Join(rootDir, "repo")
	if err := os.MkdirAll(repoPath, 0o755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}

	runGit(t, repoPath, "init", "-b", "main")
	runGit(t, repoPath, "config", "user.name", "Loop Test")
	runGit(t, repoPath, "config", "user.email", "loop@example.com")

	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	runGit(t, repoPath, "add", "README.md")
	runGit(t, repoPath, "commit", "-m", "initial commit")

	storePath := filepath.Join(rootDir, "test.db")
	s, err := sqlite.New(storePath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}

	ws := &models.Workspace{
		ID:                "ws-1",
		Name:              "Workspace",
		RootPath:          repoPath,
		CanonicalRootPath: repoPath,
	}
	if err := s.Workspaces().Create(context.Background(), ws); err != nil {
		s.Close()
		t.Fatalf("create workspace: %v", err)
	}

	mux := http.NewServeMux()
	NewWorkspaceHandler(s, "gemini-3.1-pro-preview").RegisterRoutes(mux)

	return repoPath, mux, func() {
		s.Close()
	}
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(output))
	}
	return string(bytes.TrimSpace(output))
}
