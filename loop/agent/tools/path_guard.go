package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"loop/models"
)

type pathGuard struct {
	workspaceRoot string
	allowedRoots  []string
	initErr       error
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
