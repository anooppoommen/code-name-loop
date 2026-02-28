package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyPatch_AddFile(t *testing.T) {
	dir := t.TempDir()

	patch := `*** Begin Patch
*** Add File: hello.txt
+Hello world
+Second line
*** End Patch`

	result, err := applyPatch(dir, patch)
	if err != nil {
		t.Fatalf("applyPatch failed: %v", err)
	}

	if !strings.Contains(result, "Added hello.txt") {
		t.Errorf("expected 'Added hello.txt', got %q", result)
	}

	content, _ := os.ReadFile(filepath.Join(dir, "hello.txt"))
	if !strings.Contains(string(content), "Hello world") {
		t.Errorf("expected file content 'Hello world', got %q", string(content))
	}
}

func TestApplyPatch_DeleteFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "obsolete.txt"), []byte("old content\n"), 0o644)

	patch := `*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch`

	result, err := applyPatch(dir, patch)
	if err != nil {
		t.Fatalf("applyPatch failed: %v", err)
	}

	if !strings.Contains(result, "Deleted obsolete.txt") {
		t.Errorf("expected 'Deleted obsolete.txt', got %q", result)
	}

	if _, err := os.Stat(filepath.Join(dir, "obsolete.txt")); !os.IsNotExist(err) {
		t.Error("file should have been deleted")
	}
}

func TestApplyPatch_UpdateFile(t *testing.T) {
	dir := t.TempDir()
	original := "def greet():\n    print(\"Hi\")\n    return True\n"
	os.WriteFile(filepath.Join(dir, "app.py"), []byte(original), 0o644)

	patch := "*** Begin Patch\n*** Update File: app.py\n@@ def greet():\n def greet():\n-    print(\"Hi\")\n+    print(\"Hello, world!\")\n     return True\n*** End Patch"

	result, err := applyPatch(dir, patch)
	if err != nil {
		t.Fatalf("applyPatch failed: %v", err)
	}

	if !strings.Contains(result, "Updated app.py") {
		t.Errorf("expected 'Updated app.py', got %q", result)
	}

	content, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	if !strings.Contains(string(content), `print("Hello, world!")`) {
		t.Errorf("expected updated content, got %q", string(content))
	}
	if strings.Contains(string(content), `print("Hi")`) {
		t.Error("old content should have been removed")
	}
}

func TestApplyPatch_UpdateFileWithMove(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "old.txt"), []byte("content\n"), 0o644)

	patch := `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
 content
*** End Patch`

	result, err := applyPatch(dir, patch)
	if err != nil {
		t.Fatalf("applyPatch failed: %v", err)
	}

	if !strings.Contains(result, "Updated old.txt → new.txt") {
		t.Errorf("expected move summary, got %q", result)
	}

	if _, err := os.Stat(filepath.Join(dir, "old.txt")); !os.IsNotExist(err) {
		t.Error("old file should have been removed after move")
	}
	if _, err := os.Stat(filepath.Join(dir, "new.txt")); err != nil {
		t.Error("new file should exist after move")
	}
}

func TestApplyPatch_MultiFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "existing.txt"), []byte("line one\nline two\n"), 0o644)

	patch := `*** Begin Patch
*** Add File: new.txt
+brand new file
*** Update File: existing.txt
@@
 line one
-line two
+line updated
*** Delete File: temp.txt
*** End Patch`

	// temp.txt doesn't exist but delete should succeed silently.
	result, err := applyPatch(dir, patch)
	if err != nil {
		t.Fatalf("applyPatch failed: %v", err)
	}

	if !strings.Contains(result, "Added new.txt") {
		t.Error("expected 'Added new.txt'")
	}
	if !strings.Contains(result, "Updated existing.txt") {
		t.Error("expected 'Updated existing.txt'")
	}
}

func TestApplyPatch_InvalidPatch(t *testing.T) {
	dir := t.TempDir()

	_, err := applyPatch(dir, "not a patch")
	if err == nil {
		t.Fatal("expected error for invalid patch")
	}
}

func TestApplyPatch_AddFileWithSubdirs(t *testing.T) {
	dir := t.TempDir()

	patch := `*** Begin Patch
*** Add File: deep/nested/file.txt
+nested content
*** End Patch`

	_, err := applyPatch(dir, patch)
	if err != nil {
		t.Fatalf("applyPatch failed: %v", err)
	}

	content, _ := os.ReadFile(filepath.Join(dir, "deep", "nested", "file.txt"))
	if !strings.Contains(string(content), "nested content") {
		t.Error("file should have been created with correct content")
	}
}
