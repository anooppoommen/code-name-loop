package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadFile_BasicRange(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	path := filepath.Join(dir, "test.txt")
	os.WriteFile(path, []byte("alpha\nbeta\ngamma\n"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"file_path": path,
		"offset":    2,
		"limit":     2,
	})

	result, err := handleReadFile(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "L2: beta") {
		t.Errorf("expected L2: beta, got %q", output)
	}
	if !strings.Contains(output, "L3: gamma") {
		t.Errorf("expected L3: gamma, got %q", output)
	}
}

func TestReadFile_OffsetExceedsLength(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	path := filepath.Join(dir, "test.txt")
	os.WriteFile(path, []byte("only\n"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"file_path": path,
		"offset":    100,
	})

	_, err := handleReadFile(context.Background(), args, guard, nil)
	if err == nil {
		t.Fatal("expected error for offset exceeding length")
	}
}

func TestReadFile_AcceptsWorkspaceRelativePath(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	path := filepath.Join(dir, "relative.txt")
	os.WriteFile(path, []byte("hello\n"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"file_path": "relative.txt",
	})

	result, err := handleReadFile(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("unexpected error for workspace-relative path: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if !strings.Contains(output, "L1: hello") {
		t.Fatalf("expected file contents in output, got %q", output)
	}
}

func TestReadFile_TruncatesLongLines(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	path := filepath.Join(dir, "long.txt")
	longLine := strings.Repeat("x", 600)
	os.WriteFile(path, []byte(longLine+"\n"), 0o644)

	args, _ := json.Marshal(map[string]any{"file_path": path})
	result, err := handleReadFile(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	// "L1: " = 4 chars + 500 chars max = 504
	expectedMax := "L1: " + strings.Repeat("x", 500)
	if !strings.HasPrefix(output, expectedMax) {
		t.Errorf("line should be truncated to 500 chars")
	}
}

func TestReadFile_CRLF(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	path := filepath.Join(dir, "crlf.txt")
	os.WriteFile(path, []byte("one\r\ntwo\r\n"), 0o644)

	args, _ := json.Marshal(map[string]any{"file_path": path})
	result, _ := handleReadFile(context.Background(), args, guard, nil)

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if strings.Contains(output, "\r") {
		t.Error("output should not contain \\r")
	}
}

func TestReadFile_RespectsGitIgnoreByDefault(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "secret.txt\n")
	guard := newPathGuard(testWorkspace(dir))

	path := filepath.Join(dir, "secret.txt")
	os.WriteFile(path, []byte("top-secret\n"), 0o644)

	args, _ := json.Marshal(map[string]any{"file_path": path})
	_, err := handleReadFile(context.Background(), args, guard, nil)
	if err == nil {
		t.Fatal("expected read_file to reject .gitignore-excluded path by default")
	}
	if !strings.Contains(err.Error(), ".gitignore") {
		t.Fatalf("expected .gitignore error, got %v", err)
	}
}

func TestReadFile_AllowsIgnoredWhenExplicit(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "secret.txt\n")
	guard := newPathGuard(testWorkspace(dir))

	path := filepath.Join(dir, "secret.txt")
	os.WriteFile(path, []byte("top-secret\n"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"file_path":       path,
		"include_ignored": true,
	})
	result, err := handleReadFile(context.Background(), args, guard, nil)
	if err != nil {
		t.Fatalf("unexpected error with include_ignored=true: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if !strings.Contains(output, "top-secret") {
		t.Fatalf("expected ignored file contents, got %q", output)
	}
}
