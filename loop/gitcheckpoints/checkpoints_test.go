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

func TestCreateAndRestoreSnapshotScopedWorkspaceLeavesSiblingPathsAlone(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	ctx := context.Background()
	repo := t.TempDir()
	runGitOrFatal(t, ctx, repo, "init")
	runGitOrFatal(t, ctx, repo, "config", "user.name", "Loop Test")
	runGitOrFatal(t, ctx, repo, "config", "user.email", "loop@example.com")

	workspace := filepath.Join(repo, "apps", "demo")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	workspaceTracked := filepath.Join(workspace, "tracked.txt")
	siblingTracked := filepath.Join(repo, "README.md")
	if err := os.WriteFile(workspaceTracked, []byte("initial workspace\n"), 0o644); err != nil {
		t.Fatalf("write workspace tracked: %v", err)
	}
	if err := os.WriteFile(siblingTracked, []byte("initial sibling\n"), 0o644); err != nil {
		t.Fatalf("write sibling tracked: %v", err)
	}
	runGitOrFatal(t, ctx, repo, "add", "apps/demo/tracked.txt", "README.md")
	runGitOrFatal(t, ctx, repo, "commit", "-m", "initial")

	preservedFile := filepath.Join(workspace, "keep.txt")
	preservedDirFile := filepath.Join(workspace, "cache", "seed.txt")
	if err := os.MkdirAll(filepath.Dir(preservedDirFile), 0o755); err != nil {
		t.Fatalf("mkdir preserved dir: %v", err)
	}
	if err := os.WriteFile(preservedFile, []byte("keep-before\n"), 0o644); err != nil {
		t.Fatalf("write preserved file: %v", err)
	}
	if err := os.WriteFile(preservedDirFile, []byte("cache-before\n"), 0o644); err != nil {
		t.Fatalf("write preserved dir file: %v", err)
	}

	if err := os.WriteFile(workspaceTracked, []byte("workspace snapshot\n"), 0o644); err != nil {
		t.Fatalf("write workspace snapshot state: %v", err)
	}
	if err := os.WriteFile(preservedFile, []byte("keep-snapshot\n"), 0o644); err != nil {
		t.Fatalf("write preserved snapshot state: %v", err)
	}
	if err := os.WriteFile(preservedDirFile, []byte("cache-snapshot\n"), 0o644); err != nil {
		t.Fatalf("write preserved dir snapshot state: %v", err)
	}

	snapshot, err := Create(ctx, workspace, "refs/loop/checkpoints/test/scoped-snap-1", "scoped checkpoint")
	if err != nil {
		t.Fatalf("create scoped snapshot: %v", err)
	}

	postSnapshotFile := filepath.Join(workspace, "scratch.txt")
	postSnapshotDirFile := filepath.Join(workspace, "tmp", "generated.txt")
	if err := os.WriteFile(workspaceTracked, []byte("workspace after\n"), 0o644); err != nil {
		t.Fatalf("write workspace after state: %v", err)
	}
	if err := os.WriteFile(preservedFile, []byte("keep-after\n"), 0o644); err != nil {
		t.Fatalf("write preserved after state: %v", err)
	}
	if err := os.WriteFile(preservedDirFile, []byte("cache-after\n"), 0o644); err != nil {
		t.Fatalf("write preserved dir after state: %v", err)
	}
	if err := os.WriteFile(siblingTracked, []byte("sibling after\n"), 0o644); err != nil {
		t.Fatalf("write sibling after state: %v", err)
	}
	if err := os.WriteFile(postSnapshotFile, []byte("remove me\n"), 0o644); err != nil {
		t.Fatalf("write post-snapshot file: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(postSnapshotDirFile), 0o755); err != nil {
		t.Fatalf("mkdir post-snapshot dir: %v", err)
	}
	if err := os.WriteFile(postSnapshotDirFile, []byte("remove dir me\n"), 0o644); err != nil {
		t.Fatalf("write post-snapshot dir file: %v", err)
	}

	if err := Restore(ctx, workspace, snapshot); err != nil {
		t.Fatalf("restore scoped snapshot: %v", err)
	}

	gotWorkspaceTracked, err := os.ReadFile(workspaceTracked)
	if err != nil {
		t.Fatalf("read workspace tracked after restore: %v", err)
	}
	if string(gotWorkspaceTracked) != "workspace snapshot\n" {
		t.Fatalf("workspace tracked after restore = %q, want %q", string(gotWorkspaceTracked), "workspace snapshot\n")
	}

	gotPreservedFile, err := os.ReadFile(preservedFile)
	if err != nil {
		t.Fatalf("read preserved file after restore: %v", err)
	}
	if string(gotPreservedFile) != "keep-snapshot\n" {
		t.Fatalf("preserved file after restore = %q, want %q", string(gotPreservedFile), "keep-snapshot\n")
	}

	gotPreservedDirFile, err := os.ReadFile(preservedDirFile)
	if err != nil {
		t.Fatalf("read preserved dir file after restore: %v", err)
	}
	if string(gotPreservedDirFile) != "cache-snapshot\n" {
		t.Fatalf("preserved dir file after restore = %q, want %q", string(gotPreservedDirFile), "cache-snapshot\n")
	}

	gotSiblingTracked, err := os.ReadFile(siblingTracked)
	if err != nil {
		t.Fatalf("read sibling tracked after restore: %v", err)
	}
	if string(gotSiblingTracked) != "sibling after\n" {
		t.Fatalf("sibling tracked after restore = %q, want %q", string(gotSiblingTracked), "sibling after\n")
	}

	if _, err := os.Stat(postSnapshotFile); !os.IsNotExist(err) {
		t.Fatalf("post-snapshot file should be removed, stat err=%v", err)
	}
	if _, err := os.Stat(postSnapshotDirFile); !os.IsNotExist(err) {
		t.Fatalf("post-snapshot dir file should be removed, stat err=%v", err)
	}
}

func TestRestorePreservesNewFilesInsidePreexistingUntrackedDirectories(t *testing.T) {
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

	preexistingDirFile := filepath.Join(repo, "cache", "seed.txt")
	if err := os.MkdirAll(filepath.Dir(preexistingDirFile), 0o755); err != nil {
		t.Fatalf("mkdir preexisting dir: %v", err)
	}
	if err := os.WriteFile(preexistingDirFile, []byte("seed-before\n"), 0o644); err != nil {
		t.Fatalf("write preexisting dir file: %v", err)
	}

	if err := os.WriteFile(tracked, []byte("snapshot\n"), 0o644); err != nil {
		t.Fatalf("write tracked snapshot: %v", err)
	}
	if err := os.WriteFile(preexistingDirFile, []byte("seed-snapshot\n"), 0o644); err != nil {
		t.Fatalf("write preexisting snapshot state: %v", err)
	}

	snapshot, err := Create(ctx, repo, "refs/loop/checkpoints/test/snap-preexisting-dir", "preserve dir")
	if err != nil {
		t.Fatalf("create snapshot: %v", err)
	}

	createdInsideDir := filepath.Join(repo, "cache", "generated.txt")
	if err := os.WriteFile(createdInsideDir, []byte("keep me\n"), 0o644); err != nil {
		t.Fatalf("write file inside preexisting dir: %v", err)
	}
	if err := os.WriteFile(preexistingDirFile, []byte("seed-after\n"), 0o644); err != nil {
		t.Fatalf("write preexisting dir file after snapshot: %v", err)
	}

	if err := Restore(ctx, repo, snapshot); err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}

	gotPreexisting, err := os.ReadFile(preexistingDirFile)
	if err != nil {
		t.Fatalf("read preexisting dir file after restore: %v", err)
	}
	if string(gotPreexisting) != "seed-snapshot\n" {
		t.Fatalf("preexisting dir file after restore = %q, want %q", string(gotPreexisting), "seed-snapshot\n")
	}

	gotCreatedInsideDir, err := os.ReadFile(createdInsideDir)
	if err != nil {
		t.Fatalf("read generated file inside preexisting dir after restore: %v", err)
	}
	if string(gotCreatedInsideDir) != "keep me\n" {
		t.Fatalf("generated file inside preexisting dir after restore = %q, want %q", string(gotCreatedInsideDir), "keep me\n")
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
