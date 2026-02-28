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
	os.WriteFile(filepath.Join(dir, "match.txt"), []byte("alpha beta gamma"), 0o644)
	os.WriteFile(filepath.Join(dir, "other.txt"), []byte("omega"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"pattern": "alpha",
		"path":    dir,
	})

	result, err := handleGrepFiles(context.Background(), args)
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
	os.WriteFile(filepath.Join(dir, "file.txt"), []byte("nothing here"), 0o644)

	args, _ := json.Marshal(map[string]any{
		"pattern": "nonexistent_pattern_xyz",
		"path":    dir,
	})

	result, err := handleGrepFiles(context.Background(), args)
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
	args, _ := json.Marshal(map[string]any{
		"pattern": "",
	})

	_, err := handleGrepFiles(context.Background(), args)
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
