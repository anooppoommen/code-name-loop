package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListDir_BasicListing(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	os.WriteFile(filepath.Join(dir, "file_a.txt"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(dir, "file_b.txt"), []byte("b"), 0o644)
	os.MkdirAll(filepath.Join(dir, "subdir"), 0o755)

	args, _ := json.Marshal(map[string]any{"dir_path": dir})
	result, err := handleListDir(context.Background(), args, guard)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "file_a.txt") {
		t.Error("expected file_a.txt")
	}
	if !strings.Contains(output, "file_b.txt") {
		t.Error("expected file_b.txt")
	}
	if !strings.Contains(output, "subdir/") {
		t.Error("expected subdir/")
	}
}

func TestListDir_DepthControl(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	os.MkdirAll(filepath.Join(dir, "a", "b", "c"), 0o755)
	os.WriteFile(filepath.Join(dir, "a", "b", "c", "deep.txt"), []byte("d"), 0o644)

	// Depth 1 should only show immediate children.
	args, _ := json.Marshal(map[string]any{"dir_path": dir, "depth": 1})
	result, _ := handleListDir(context.Background(), args, guard)

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "a/") {
		t.Error("expected a/ in depth-1 listing")
	}
	if strings.Contains(output, "deep.txt") {
		t.Error("deep.txt should not appear at depth 1")
	}
}

func TestListDir_Pagination(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	for i := 0; i < 10; i++ {
		os.WriteFile(filepath.Join(dir, strings.Repeat("a", i+1)+".txt"), []byte("x"), 0o644)
	}

	args, _ := json.Marshal(map[string]any{"dir_path": dir, "limit": 3})
	result, _ := handleListDir(context.Background(), args, guard)

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "More than 3 entries found") {
		t.Error("expected truncation indicator")
	}
}

func TestListDir_AcceptsWorkspaceRelativePath(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	if err := os.MkdirAll(filepath.Join(dir, "relative"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	args, _ := json.Marshal(map[string]any{"dir_path": "relative"})
	result, err := handleListDir(context.Background(), args, guard)
	if err != nil {
		t.Fatalf("unexpected error for relative path: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if !strings.Contains(output, "Absolute path: ") {
		t.Fatalf("expected absolute path header, got %q", output)
	}
}

func TestListDir_Sorted(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	os.WriteFile(filepath.Join(dir, "z.txt"), []byte("z"), 0o644)
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(dir, "m.txt"), []byte("m"), 0o644)

	args, _ := json.Marshal(map[string]any{"dir_path": dir})
	result, _ := handleListDir(context.Background(), args, guard)

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	aIdx := strings.Index(output, "a.txt")
	mIdx := strings.Index(output, "m.txt")
	zIdx := strings.Index(output, "z.txt")

	if aIdx > mIdx || mIdx > zIdx {
		t.Errorf("entries should be sorted: a(%d) < m(%d) < z(%d)", aIdx, mIdx, zIdx)
	}
}

func TestListDir_RespectsGitIgnoreByDefault(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "ignored.txt\nignored_dir/\n")
	guard := newPathGuard(testWorkspace(dir))

	os.WriteFile(filepath.Join(dir, "visible.txt"), []byte("v"), 0o644)
	os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("i"), 0o644)
	os.MkdirAll(filepath.Join(dir, "ignored_dir"), 0o755)
	os.WriteFile(filepath.Join(dir, "ignored_dir", "inside.txt"), []byte("x"), 0o644)

	args, _ := json.Marshal(map[string]any{"dir_path": dir, "depth": 2, "limit": 50})
	result, err := handleListDir(context.Background(), args, guard)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if strings.Contains(output, "ignored.txt") || strings.Contains(output, "ignored_dir/") {
		t.Fatalf("ignored paths should be excluded by default, got %q", output)
	}
	if !strings.Contains(output, "visible.txt") {
		t.Fatalf("expected visible file in output, got %q", output)
	}
}

func TestListDir_AllowsIgnoredWhenExplicit(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "ignored_dir/\n")
	guard := newPathGuard(testWorkspace(dir))

	os.MkdirAll(filepath.Join(dir, "ignored_dir"), 0o755)
	os.WriteFile(filepath.Join(dir, "ignored_dir", "inside.txt"), []byte("x"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"dir_path":        dir,
		"depth":           2,
		"limit":           50,
		"include_ignored": true,
	})
	result, err := handleListDir(context.Background(), args, guard)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)
	if !strings.Contains(output, "ignored_dir/") {
		t.Fatalf("expected ignored directory in output when include_ignored=true, got %q", output)
	}
}
