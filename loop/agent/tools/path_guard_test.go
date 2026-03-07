package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestPathGuard_WorkdirDefaultsToWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	g := newPathGuard(testWorkspace(root))

	got, err := g.requireAllowedWorkdir(context.Background(), "", nil, "test")
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

	got, err := g.requireAllowedWorkdir(context.Background(), "subdir", nil, "test")
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

func TestPathGuard_RejectIfGitIgnoredConcurrent(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "*.secret\n")

	g := newPathGuard(testWorkspace(dir))
	ctx := context.Background()

	const workers = 64
	errCh := make(chan error, workers)
	start := make(chan struct{})
	var wg sync.WaitGroup

	for i := range workers {
		path := filepath.Join(dir, fmt.Sprintf("file_%d.secret", i))
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("write file: %v", err)
		}

		wg.Add(1)
		go func(filePath string) {
			defer wg.Done()
			<-start
			err := g.rejectIfGitIgnored(ctx, filePath, false)
			if err == nil {
				errCh <- fmt.Errorf("expected .gitignore rejection for %s", filePath)
				return
			}
			if !strings.Contains(err.Error(), ".gitignore") {
				errCh <- fmt.Errorf("expected .gitignore error for %s, got %v", filePath, err)
			}
		}(path)
	}

	close(start)
	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Fatal(err)
	}
}
