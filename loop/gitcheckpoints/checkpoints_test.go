package gitcheckpoints

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCreateAndRestoreSnapshotRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	tracked := filepath.Join(repo, "tracked.txt")
	if err := os.WriteFile(tracked, []byte("initial\n"), 0o644); err != nil {
		t.Fatalf("write tracked initial: %v", err)
	}
	runGitOrFatal(t, ctx, repo, "add", "tracked.txt")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	preexisting := filepath.Join(repo, "keep.txt")
	if err := os.WriteFile(preexisting, []byte("keep me\n"), 0o644); err != nil {
		t.Fatalf("write preexisting untracked: %v", err)
	}

	if err := os.WriteFile(tracked, []byte("snapshot\n"), 0o644); err != nil {
		t.Fatalf("write tracked snapshot: %v", err)
	}
	snapshot, err := Create(ctx, repo, "refs/loop/checkpoints/test/snap-1", "test checkpoint")
	if err != nil {
		t.Fatalf("create snapshot: %v", err)
	}
	if snapshot.CommitID == "" {
		t.Fatalf("snapshot commit id is empty")
	}

	postSnapshot := filepath.Join(repo, "new-after.txt")
	if err := os.WriteFile(postSnapshot, []byte("delete me\n"), 0o644); err != nil {
		t.Fatalf("write post-snapshot file: %v", err)
	}
	if err := os.WriteFile(tracked, []byte("after\n"), 0o644); err != nil {
		t.Fatalf("write tracked after snapshot: %v", err)
	}

	if err := Restore(ctx, repo, snapshot); err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}

	gotTracked, err := os.ReadFile(tracked)
	if err != nil {
		t.Fatalf("read tracked after restore: %v", err)
	}
	if string(gotTracked) != "snapshot\n" {
		t.Fatalf("tracked contents = %q, want %q", string(gotTracked), "snapshot\n")
	}

	if _, err := os.Stat(preexisting); err != nil {
		t.Fatalf("preexisting file should remain: %v", err)
	}
	if _, err := os.Stat(postSnapshot); !os.IsNotExist(err) {
		t.Fatalf("post-snapshot file should be removed, err=%v", err)
	}
}

func TestCreateReturnsNotGitRepositoryOutsideRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	ctx := context.Background()
	workspace := t.TempDir()

	_, err := Create(ctx, workspace, "refs/loop/checkpoints/test/snap-1", "test")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, ErrNotGitRepository) {
		t.Fatalf("expected ErrNotGitRepository, got: %v", err)
	}
}

func runGitOrFatal(t *testing.T, ctx context.Context, repo string, args ...string) string {
	t.Helper()
	out, err := runGit(ctx, repo, nil, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return out
}
