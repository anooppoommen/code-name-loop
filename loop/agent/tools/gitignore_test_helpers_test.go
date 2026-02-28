package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func initGitRepo(t *testing.T, dir string) {
	t.Helper()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}

	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init failed: %v (%s)", err, string(out))
	}
}

func writeGitignore(t *testing.T, dir string, content string) {
	t.Helper()
	path := filepath.Join(dir, ".gitignore")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write .gitignore: %v", err)
	}
}
