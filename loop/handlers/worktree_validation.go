package handlers

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"loop/models"
)

func workspaceCanonicalRoot(ws *models.Workspace) string {
	if ws == nil {
		return ""
	}
	if trimmed := strings.TrimSpace(ws.CanonicalRootPath); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(ws.RootPath)
}

func validateWorkspaceWorktreePath(ctx context.Context, ws *models.Workspace, requestedPath string) (string, error) {
	if ws == nil {
		return "", fmt.Errorf("workspace is required")
	}
	trimmed := strings.TrimSpace(requestedPath)
	if trimmed == "" {
		return "", nil
	}

	workspaceRoot, err := canonicalizeHandlerPath(workspaceCanonicalRoot(ws))
	if err != nil {
		return "", fmt.Errorf("invalid workspace root: %w", err)
	}
	worktreePath, err := canonicalizeHandlerPath(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid worktree path: %w", err)
	}

	allowedPaths, err := listGitWorktreePaths(ctx, workspaceRoot)
	if err != nil {
		return "", err
	}
	for _, allowed := range allowedPaths {
		if allowed == worktreePath {
			return worktreePath, nil
		}
	}

	return "", fmt.Errorf("path %q is not a registered git worktree for %q", worktreePath, workspaceRoot)
}

func listGitWorktreePaths(ctx context.Context, repoPath string) ([]string, error) {
	cmd := exec.CommandContext(ctx, "git", "worktree", "list", "--porcelain")
	cmd.Dir = repoPath
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("list git worktrees: %s", message)
	}

	var paths []string
	for _, line := range strings.Split(string(output), "\n") {
		if !strings.HasPrefix(line, "worktree ") {
			continue
		}
		resolved, err := canonicalizeHandlerPath(strings.TrimPrefix(line, "worktree "))
		if err != nil {
			continue
		}
		paths = append(paths, resolved)
	}
	return dedupeHandlerStrings(paths), nil
}

func canonicalizeHandlerPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)

	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}

	cur := abs
	for {
		if _, statErr := os.Lstat(cur); statErr == nil {
			resolvedParent, err := filepath.EvalSymlinks(cur)
			if err != nil {
				return "", err
			}
			rel, err := filepath.Rel(cur, abs)
			if err != nil {
				return "", err
			}
			return filepath.Clean(filepath.Join(resolvedParent, rel)), nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}

	return abs, nil
}

func dedupeHandlerStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, item := range in {
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}
