package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"loop/models"
)

type pathGuard struct {
	workspaceRoot  string
	allowedRoots   []string
	gitIgnoreCache map[string]bool
	initErr        error
}

func newPathGuard(ws *models.Workspace) *pathGuard {
	g := &pathGuard{}
	if ws == nil {
		g.initErr = fmt.Errorf("workspace context is required")
		return g
	}

	root := strings.TrimSpace(ws.CanonicalRootPath)
	if root == "" {
		root = strings.TrimSpace(ws.RootPath)
	}
	if root == "" {
		g.initErr = fmt.Errorf("workspace root path is empty")
		return g
	}

	canonRoot, err := canonicalizePath(root)
	if err != nil {
		g.initErr = fmt.Errorf("invalid workspace root path: %w", err)
		return g
	}
	g.workspaceRoot = canonRoot
	g.allowedRoots = append(g.allowedRoots, canonRoot)
	g.gitIgnoreCache = make(map[string]bool)

	for _, grant := range ws.PathGrants {
		grantPath := strings.TrimSpace(grant.CanonicalPath)
		if grantPath == "" {
			continue
		}
		canonGrant, err := canonicalizePath(grantPath)
		if err != nil {
			continue
		}
		g.allowedRoots = append(g.allowedRoots, canonGrant)
	}

	g.allowedRoots = dedupeStrings(g.allowedRoots)
	return g
}

func (g *pathGuard) requireAllowedPath(path string) (string, error) {
	if g.initErr != nil {
		return "", g.initErr
	}
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("path must not be empty")
	}
	canonPath, err := canonicalizePath(path)
	if err != nil {
		return "", fmt.Errorf("invalid path %q: %w", path, err)
	}
	for _, root := range g.allowedRoots {
		if isWithinRoot(canonPath, root) {
			return canonPath, nil
		}
	}
	return "", fmt.Errorf("path %q is outside workspace/granted roots (workspace root: %q)", canonPath, g.workspaceRoot)
}

func (g *pathGuard) requireAllowedWorkdir(path string) (string, error) {
	if g.initErr != nil {
		return "", g.initErr
	}
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return g.workspaceRoot, nil
	}
	if !filepath.IsAbs(trimmed) {
		trimmed = filepath.Join(g.workspaceRoot, trimmed)
	}
	return g.requireAllowedPath(trimmed)
}

func (g *pathGuard) resolveForPatch(path string) (string, error) {
	if g.initErr != nil {
		return "", g.initErr
	}
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", fmt.Errorf("path must not be empty")
	}
	candidate := trimmed
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(g.workspaceRoot, candidate)
	}
	return g.requireAllowedPath(candidate)
}

func (g *pathGuard) rejectIfGitIgnored(ctx context.Context, path string, allowIgnored bool) error {
	if allowIgnored {
		return nil
	}
	if g.initErr != nil {
		return g.initErr
	}
	if strings.TrimSpace(path) == "" {
		return nil
	}
	canonPath, err := canonicalizePath(path)
	if err != nil {
		return fmt.Errorf("invalid path %q: %w", path, err)
	}

	ignored, err := g.isGitIgnored(ctx, canonPath)
	if err != nil {
		return err
	}
	if ignored {
		return fmt.Errorf("path %q is excluded by .gitignore; include it only when absolutely necessary", canonPath)
	}
	return nil
}

func (g *pathGuard) isGitIgnored(ctx context.Context, canonPath string) (bool, error) {
	if g.initErr != nil {
		return false, g.initErr
	}

	// .gitignore applicability is scoped to the workspace root.
	if !isWithinRoot(canonPath, g.workspaceRoot) {
		return false, nil
	}

	if ignored, ok := g.gitIgnoreCache[canonPath]; ok {
		return ignored, nil
	}

	rel, err := filepath.Rel(g.workspaceRoot, canonPath)
	if err != nil || rel == "." {
		return false, nil
	}

	cmd := exec.CommandContext(ctx, "git", "-C", g.workspaceRoot, "check-ignore", "--quiet", "--no-index", "--", filepath.ToSlash(rel))
	err = cmd.Run()
	switch {
	case err == nil:
		g.gitIgnoreCache[canonPath] = true
		return true, nil
	case isExitCode(err, 1):
		g.gitIgnoreCache[canonPath] = false
		return false, nil
	case isExitCode(err, 128), isNotFound(err):
		// Not a git repo or git unavailable: do not block.
		g.gitIgnoreCache[canonPath] = false
		return false, nil
	default:
		return false, nil
	}
}

func canonicalizePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)

	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}

	// For paths that may not exist yet, resolve symlinks on nearest existing parent.
	cur := abs
	for {
		_, statErr := os.Lstat(cur)
		if statErr == nil {
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

func isWithinRoot(path string, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func isExitCode(err error, code int) bool {
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		return false
	}
	return exitErr.ExitCode() == code
}
