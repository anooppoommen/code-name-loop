package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGrepFiles_BasicSearch(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	os.WriteFile(filepath.Join(dir, "match.txt"), []byte("alpha beta gamma"), 0o644)
	os.WriteFile(filepath.Join(dir, "other.txt"), []byte("omega"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"pattern": "alpha",
		"path":    dir,
	})

	result, err := handleGrepFiles(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("handleGrepFiles failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "match.txt") {
		t.Errorf("expected match.txt in output, got %q", output)
	}
}

func TestGrepFiles_NoMatches(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	os.WriteFile(filepath.Join(dir, "file.txt"), []byte("nothing here"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"pattern": "nonexistent_pattern_xyz",
		"path":    dir,
	})

	result, err := handleGrepFiles(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("handleGrepFiles failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if output != "No matches found." {
		t.Errorf("expected 'No matches found.', got %q", output)
	}
}

func TestGrepFiles_EmptyPattern(t *testing.T) {
	guard := newPathGuard(testWorkspace(t.TempDir()))
	args, _ := json.Marshal(map[string]any{
		"pattern": "",
	})

	_, err := handleGrepFiles(context.Background(), args, guard, nil)
	if err == nil {
		t.Fatal("expected error for empty pattern")
	}
}

func TestGrepFiles_ParseResults(t *testing.T) {
	stdout := []byte("/tmp/file_a.rs\n/tmp/file_b.rs\n")
	results := parseSearchResults(stdout, 10)

	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0] != "/tmp/file_a.rs" {
		t.Errorf("expected /tmp/file_a.rs, got %q", results[0])
	}
}

func TestGrepFiles_ParseResultsRespectsLimit(t *testing.T) {
	stdout := []byte("/tmp/a.rs\n/tmp/b.rs\n/tmp/c.rs\n")
	results := parseSearchResults(stdout, 2)

	if len(results) != 2 {
		t.Fatalf("expected 2 results (limit), got %d", len(results))
	}
}

func TestGrepFiles_RespectsGitIgnoreByDefault(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "ignored.txt\n")
	guard := newPathGuard(testWorkspace(dir))

	os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("alpha"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"pattern": "alpha",
		"path":    dir,
	})
	result, err := handleGrepFiles(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("handleGrepFiles failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if output != "No matches found." {
		t.Fatalf("expected ignored file to be skipped by default, got %q", output)
	}
}

func TestGrepFiles_AllowsIgnoredWhenExplicit(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "ignored.txt\n")
	guard := newPathGuard(testWorkspace(dir))

	path := filepath.Join(dir, "ignored.txt")
	os.WriteFile(path, []byte("alpha"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"pattern":         "alpha",
		"path":            path,
		"include_ignored": true,
	})
	result, err := handleGrepFiles(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("handleGrepFiles failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if !strings.Contains(output, "ignored.txt") {
		t.Fatalf("expected explicit ignored search to succeed, got %q", output)
	}
}

func TestGrepFiles_ApprovedExternalPathReturnsMatches(t *testing.T) {
	workspaceDir := t.TempDir()
	externalDir := t.TempDir()
	guard := newPathGuard(testWorkspace(workspaceDir))
	canonExternalDir, err := canonicalizePath(externalDir)
	if err != nil {
		t.Fatalf("canonicalize external dir: %v", err)
	}

	matchPath := filepath.Join(externalDir, "external.txt")
	os.WriteFile(matchPath, []byte("alpha"), 0o644)

	requestCount := 0
	requester := CommandApprovalRequesterFunc(func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error) {
		requestCount++
		if req.ToolName != "grep_files" {
			t.Fatalf("unexpected tool name %q", req.ToolName)
		}
		if req.Command != canonExternalDir {
			t.Fatalf("expected approved path %q, got %q", canonExternalDir, req.Command)
		}
		return CommandApprovalResolution{Decision: CommandApprovalDecisionAllowOnce}, nil
	})

	args, _ := json.Marshal(map[string]any{
		"pattern": "alpha",
		"path":    externalDir,
	})
	result, err := handleGrepFiles(context.Background(), args, guard, requester)
	if err != nil {
		t.Fatalf("handleGrepFiles failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if !strings.Contains(output, "external.txt") {
		t.Fatalf("expected external match in output, got %q", output)
	}
	if requestCount != 1 {
		t.Fatalf("approval requester called %d times, want 1", requestCount)
	}
}

func TestFilterIgnoredResults_RestrictsResultsToApprovedExternalRoot(t *testing.T) {
	workspaceDir := t.TempDir()
	externalDir := t.TempDir()
	otherDir := t.TempDir()
	guard := newPathGuard(testWorkspace(workspaceDir))
	canonExternalDir, err := canonicalizePath(externalDir)
	if err != nil {
		t.Fatalf("canonicalize external dir: %v", err)
	}

	allowedPath := filepath.Join(externalDir, "allowed.txt")
	blockedPath := filepath.Join(otherDir, "blocked.txt")
	os.WriteFile(allowedPath, []byte("alpha"), 0o644)
	os.WriteFile(blockedPath, []byte("alpha"), 0o644)

	got := filterIgnoredResults(context.Background(), []string{allowedPath, blockedPath}, guard, canonExternalDir, false)
	if len(got) != 1 {
		t.Fatalf("expected 1 filtered result, got %d (%v)", len(got), got)
	}
	if got[0] != allowedPath {
		t.Fatalf("expected allowed path %q, got %q", allowedPath, got[0])
	}
}
