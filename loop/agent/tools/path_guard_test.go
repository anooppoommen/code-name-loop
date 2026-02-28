package tools

import (
	"path/filepath"
	"testing"
)

func TestPathGuard_WorkdirDefaultsToWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	g := newPathGuard(testWorkspace(root))

	got, err := g.requireAllowedWorkdir("")
	if err != nil {
		t.Fatalf("requireAllowedWorkdir empty failed: %v", err)
	}
	want, err := canonicalizePath(root)
	if err != nil {
		t.Fatalf("canonicalize root: %v", err)
	}
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestPathGuard_WorkdirRelativeToWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	g := newPathGuard(testWorkspace(root))

	got, err := g.requireAllowedWorkdir("subdir")
	if err != nil {
		t.Fatalf("requireAllowedWorkdir relative failed: %v", err)
	}
	canonRoot, err := canonicalizePath(root)
	if err != nil {
		t.Fatalf("canonicalize root: %v", err)
	}
	want := filepath.Join(canonRoot, "subdir")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
