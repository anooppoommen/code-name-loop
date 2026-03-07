package gitcheckpoints

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

var (
	// ErrNotGitRepository indicates the requested workspace is not inside a Git repository.
	ErrNotGitRepository = errors.New("not a git repository")
	// ErrWorkspaceOutsideRepository indicates the workspace path is outside the resolved repository root.
	ErrWorkspaceOutsideRepository = errors.New("workspace path is outside repository root")
	// ErrPathNotFoundInSnapshot indicates that the requested path is not present in the snapshot commit.
	ErrPathNotFoundInSnapshot = errors.New("path not found in snapshot")
)

type Snapshot struct {
	CommitID string
	Parent   string

	// GitRef pins the commit object in the local repository.
	GitRef string

	PreexistingUntrackedFiles []string
	PreexistingUntrackedDirs  []string
}

// Create captures the current workspace state into a detached Git commit.
// The snapshot is scoped to the provided workspace path (or repository root when equal).
func Create(ctx context.Context, workspacePath string, gitRef string, message string) (*Snapshot, error) {
	scope, err := resolveScope(ctx, workspacePath)
	if err != nil {
		return nil, err
	}

	files, dirs, err := listUntracked(ctx, scope)
	if err != nil {
		return nil, err
	}

	head, _ := resolveHead(ctx, scope.RepoRoot)

	indexPath, cleanup, err := createTempIndex()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	indexEnv := []string{
		"GIT_INDEX_FILE=" + indexPath,
	}
	if head != "" {
		if _, err := runGit(ctx, scope.RepoRoot, indexEnv, "read-tree", head); err != nil {
			return nil, fmt.Errorf("read-tree: %w", err)
		}
	}

	scopeSpec := scope.Pathspec()
	if _, err := runGit(ctx, scope.RepoRoot, indexEnv, "add", "--all", "--", scopeSpec); err != nil {
		return nil, fmt.Errorf("git add: %w", err)
	}

	treeID, err := runGit(ctx, scope.RepoRoot, indexEnv, "write-tree")
	if err != nil {
		return nil, fmt.Errorf("write-tree: %w", err)
	}

	commitMsg := strings.TrimSpace(message)
	if commitMsg == "" {
		commitMsg = "loop checkpoint"
	}
	identityEnv := append(indexEnv,
		"GIT_AUTHOR_NAME=Loop",
		"GIT_AUTHOR_EMAIL=loop@local",
		"GIT_COMMITTER_NAME=Loop",
		"GIT_COMMITTER_EMAIL=loop@local",
	)
	args := []string{"commit-tree", treeID}
	if head != "" {
		args = append(args, "-p", head)
	}
	args = append(args, "-m", commitMsg)
	commitID, err := runGit(ctx, scope.RepoRoot, identityEnv, args...)
	if err != nil {
		return nil, fmt.Errorf("commit-tree: %w", err)
	}

	if strings.TrimSpace(gitRef) != "" {
		if _, err := runGit(ctx, scope.RepoRoot, nil, "update-ref", gitRef, commitID); err != nil {
			return nil, fmt.Errorf("update-ref %s: %w", gitRef, err)
		}
	}

	return &Snapshot{
		CommitID:                  commitID,
		Parent:                    head,
		GitRef:                    strings.TrimSpace(gitRef),
		PreexistingUntrackedFiles: files,
		PreexistingUntrackedDirs:  dirs,
	}, nil
}

// Restore restores the workspace to a previously captured snapshot.
func Restore(ctx context.Context, workspacePath string, snapshot *Snapshot) error {
	if snapshot == nil || strings.TrimSpace(snapshot.CommitID) == "" {
		return fmt.Errorf("invalid snapshot")
	}

	scope, err := resolveScope(ctx, workspacePath)
	if err != nil {
		return err
	}

	currFiles, currDirs, err := listUntracked(ctx, scope)
	if err != nil {
		return err
	}

	scopeSpec := scope.Pathspec()
	if _, err := runGit(ctx, scope.RepoRoot, nil, "restore", "--source", snapshot.CommitID, "--worktree", "--", scopeSpec); err != nil {
		return fmt.Errorf("git restore: %w", err)
	}

	if err := cleanupNewUntracked(scope, currFiles, currDirs, snapshot.PreexistingUntrackedFiles, snapshot.PreexistingUntrackedDirs); err != nil {
		return err
	}

	return nil
}

// ReadFileAtSnapshot returns the raw file contents captured at a snapshot-relative path.
func ReadFileAtSnapshot(ctx context.Context, workspacePath string, snapshot *Snapshot, relativePath string) ([]byte, error) {
	if snapshot == nil || strings.TrimSpace(snapshot.CommitID) == "" {
		return nil, fmt.Errorf("invalid snapshot")
	}

	scope, err := resolveScope(ctx, workspacePath)
	if err != nil {
		return nil, err
	}

	repoPath, err := snapshotRepoPath(scope, relativePath)
	if err != nil {
		return nil, err
	}

	out, err := runGitRaw(ctx, scope.RepoRoot, nil, "show", fmt.Sprintf("%s:%s", snapshot.CommitID, repoPath))
	if err != nil {
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "does not exist in") || strings.Contains(msg, "exists on disk, but not in") {
			return nil, ErrPathNotFoundInSnapshot
		}
		return nil, err
	}
	return out, nil
}

// DeleteRef removes a checkpoint ref from the repository if it exists.
func DeleteRef(ctx context.Context, workspacePath string, gitRef string) error {
	gitRef = strings.TrimSpace(gitRef)
	if gitRef == "" {
		return nil
	}
	scope, err := resolveScope(ctx, workspacePath)
	if err != nil {
		return err
	}
	if _, err := runGit(ctx, scope.RepoRoot, nil, "update-ref", "-d", gitRef); err != nil {
		// Deleting a missing ref is a no-op for callers.
		if strings.Contains(err.Error(), "cannot lock ref") || strings.Contains(err.Error(), "not a valid ref") {
			return nil
		}
		return err
	}
	return nil
}

type scopeInfo struct {
	RepoRoot string
	Prefix   string
}

func (s scopeInfo) Pathspec() string {
	if s.Prefix == "" {
		return "."
	}
	return filepath.ToSlash(s.Prefix)
}

func resolveScope(ctx context.Context, workspacePath string) (scopeInfo, error) {
	resolvedWorkspace, err := resolvedPath(workspacePath)
	if err != nil {
		return scopeInfo{}, err
	}

	repoRootRaw, err := runGit(ctx, resolvedWorkspace, nil, "rev-parse", "--show-toplevel")
	if err != nil {
		return scopeInfo{}, asNotGitErr(err)
	}

	repoRoot, err := resolvedPath(repoRootRaw)
	if err != nil {
		return scopeInfo{}, err
	}

	rel, err := filepath.Rel(repoRoot, resolvedWorkspace)
	if err != nil {
		return scopeInfo{}, fmt.Errorf("workspace relation: %w", err)
	}
	if strings.HasPrefix(rel, "..") {
		return scopeInfo{}, ErrWorkspaceOutsideRepository
	}
	if rel == "." {
		rel = ""
	}

	return scopeInfo{
		RepoRoot: repoRoot,
		Prefix:   rel,
	}, nil
}

func snapshotRepoPath(scope scopeInfo, relativePath string) (string, error) {
	clean := filepath.Clean(strings.TrimSpace(relativePath))
	if clean == "." || clean == "" {
		return "", fmt.Errorf("path is required")
	}
	if filepath.IsAbs(clean) {
		return "", fmt.Errorf("path must be relative")
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace")
	}

	if scope.Prefix == "" {
		return filepath.ToSlash(clean), nil
	}
	return filepath.ToSlash(filepath.Join(scope.Prefix, clean)), nil
}

func resolvedPath(path string) (string, error) {
	clean := strings.TrimSpace(path)
	if clean == "" {
		return "", fmt.Errorf("path is required")
	}

	abs, err := filepath.Abs(clean)
	if err != nil {
		return "", fmt.Errorf("absolute path: %w", err)
	}

	eval, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return eval, nil
	}

	// Fallback to absolute path when symlink resolution fails (e.g. path missing).
	return abs, nil
}

func resolveHead(ctx context.Context, repoRoot string) (string, error) {
	head, err := runGit(ctx, repoRoot, nil, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(head), nil
}

func listUntracked(ctx context.Context, scope scopeInfo) ([]string, []string, error) {
	scopeSpec := scope.Pathspec()
	filesRaw, err := runGitRaw(ctx, scope.RepoRoot, nil, "ls-files", "--others", "--exclude-standard", "-z", "--", scopeSpec)
	if err != nil {
		return nil, nil, fmt.Errorf("list untracked files: %w", err)
	}
	dirsRaw, err := runGitRaw(ctx, scope.RepoRoot, nil, "ls-files", "--others", "--exclude-standard", "--directory", "-z", "--", scopeSpec)
	if err != nil {
		return nil, nil, fmt.Errorf("list untracked dirs: %w", err)
	}

	files := parseNullSeparatedPaths(filesRaw)
	dirs := parseUntrackedDirs(dirsRaw)
	return files, dirs, nil
}

func parseNullSeparatedPaths(raw []byte) []string {
	raw = bytes.TrimRight(raw, "\x00")
	if len(raw) == 0 {
		return nil
	}

	parts := strings.Split(string(raw), "\x00")
	out := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		normalized := filepath.ToSlash(trimmed)
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	sort.Strings(out)
	return out
}

func parseUntrackedDirs(raw []byte) []string {
	paths := parseNullSeparatedPaths(raw)
	dirs := make([]string, 0, len(paths))
	for _, p := range paths {
		if strings.HasSuffix(p, "/") {
			dirs = append(dirs, strings.TrimSuffix(p, "/"))
		}
	}
	sort.Strings(dirs)
	return dedupe(dirs)
}

func cleanupNewUntracked(scope scopeInfo, currentFiles, currentDirs, preFiles, preDirs []string) error {
	preFilesSet := make(map[string]struct{}, len(preFiles))
	for _, p := range preFiles {
		preFilesSet[filepath.ToSlash(strings.TrimSpace(p))] = struct{}{}
	}
	preDirsSet := make(map[string]struct{}, len(preDirs))
	for _, p := range preDirs {
		normalized := filepath.ToSlash(strings.Trim(strings.TrimSpace(p), "/"))
		if normalized != "" {
			preDirsSet[normalized] = struct{}{}
		}
	}

	isPreservedByDir := func(path string) bool {
		for dir := range preDirsSet {
			if path == dir || strings.HasPrefix(path, dir+"/") {
				return true
			}
		}
		return false
	}

	for _, file := range currentFiles {
		file = filepath.ToSlash(strings.TrimSpace(file))
		if file == "" {
			continue
		}
		if _, ok := preFilesSet[file]; ok {
			continue
		}
		if isPreservedByDir(file) {
			continue
		}
		abs := filepath.Join(scope.RepoRoot, filepath.FromSlash(file))
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove untracked file %s: %w", file, err)
		}
	}

	// Remove only empty directories to avoid deleting unrelated content.
	sort.SliceStable(currentDirs, func(i, j int) bool {
		return len(currentDirs[i]) > len(currentDirs[j])
	})
	for _, dir := range currentDirs {
		dir = filepath.ToSlash(strings.Trim(strings.TrimSpace(dir), "/"))
		if dir == "" {
			continue
		}
		if _, ok := preDirsSet[dir]; ok {
			continue
		}
		if isPreservedByDir(dir) {
			continue
		}
		abs := filepath.Join(scope.RepoRoot, filepath.FromSlash(dir))
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			// Non-empty directories are expected in some cases; keep them.
			if !errors.Is(err, os.ErrExist) {
				var pathErr *os.PathError
				if errors.As(err, &pathErr) && pathErr.Err != nil && strings.Contains(pathErr.Err.Error(), "directory not empty") {
					continue
				}
			}
		}
	}

	return nil
}

func dedupe(values []string) []string {
	if len(values) == 0 {
		return values
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, v := range values {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

func createTempIndex() (string, func(), error) {
	dir, err := os.MkdirTemp("", "loop-git-index-*")
	if err != nil {
		return "", nil, fmt.Errorf("mktemp: %w", err)
	}
	indexPath := filepath.Join(dir, "index")
	cleanup := func() {
		_ = os.RemoveAll(dir)
	}
	return indexPath, cleanup, nil
}

func runGit(ctx context.Context, repoPath string, extraEnv []string, args ...string) (string, error) {
	out, err := runGitRaw(ctx, repoPath, extraEnv, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func runGitRaw(ctx context.Context, repoPath string, extraEnv []string, args ...string) ([]byte, error) {
	cmdArgs := append([]string{"-C", repoPath}, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

func asNotGitErr(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "not a git repository") || strings.Contains(msg, "outside repository") {
		return ErrNotGitRepository
	}
	return err
}
