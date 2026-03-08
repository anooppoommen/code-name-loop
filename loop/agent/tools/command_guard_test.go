package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateWorkspaceEditPolicy_BlocksMutatingCommands(t *testing.T) {
	cases := []string{
		"rm -f patch.diff",
		"cp /tmp/a.ts src/a.ts",
		"mkdir scripts",
		"sed -i 's/a/b/' src/app.ts",
		"git apply patch.diff",
		"echo boom 2> errors.txt",
	}

	for _, cmd := range cases {
		err := validateWorkspaceEditPolicy(cmd)
		if err == nil {
			t.Fatalf("expected command to be blocked: %q", cmd)
		}
		if !strings.Contains(err.Error(), "apply_patch") {
			t.Fatalf("expected remediation hint in error, got %q", err.Error())
		}
		if !strings.Contains(err.Error(), "do not retry") {
			t.Fatalf("expected non-retry guidance in error, got %q", err.Error())
		}
	}
}

func TestValidateWorkspaceEditPolicy_BlocksWorkspaceRedirection(t *testing.T) {
	cmd := "cat << 'EOF' > patch_script.py\nprint('x')\nEOF"
	err := validateWorkspaceEditPolicy(cmd)
	if err == nil {
		t.Fatal("expected workspace redirection to be blocked")
	}
	if !strings.Contains(err.Error(), "apply_patch") {
		t.Fatalf("expected remediation hint in error, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "do not retry") {
		t.Fatalf("expected non-retry guidance in error, got %q", err.Error())
	}
}

func TestValidateWorkspaceEditPolicy_AllowsSafeCommands(t *testing.T) {
	cases := []string{
		"rg -n \"TODO\" .",
		"npm run lint",
		"echo done > /dev/null",
		"printf 'x' > /tmp/codex-scratch.txt",
	}

	for _, cmd := range cases {
		if err := validateWorkspaceEditPolicy(cmd); err != nil {
			t.Fatalf("expected command to be allowed: %q (err: %v)", cmd, err)
		}
	}
}

func TestValidateGitIgnoreReadPolicy_BlocksBroadRecursiveScans(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	cases := []string{
		"find . -type f",
		"tree .",
		"ls -R .",
		"rg --no-ignore -n TODO .",
		"fd -uu TODO .",
	}

	for _, cmd := range cases {
		err := validateGitIgnoreReadPolicy(context.Background(), cmd, dir, guard)
		if err == nil {
			t.Fatalf("expected command to be blocked: %q", cmd)
		}
		if !strings.Contains(err.Error(), ".gitignore") && !strings.Contains(err.Error(), "ignore") {
			t.Fatalf("expected ignore-related error, got %q", err.Error())
		}
	}
}

func TestValidateGitIgnoreReadPolicy_BlocksIgnoredPathTargets(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "build/\n")
	if err := os.MkdirAll(filepath.Join(dir, "build"), 0o755); err != nil {
		t.Fatalf("mkdir build: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "build", "artifact.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write ignored file: %v", err)
	}

	guard := newPathGuard(testWorkspace(dir))
	err := validateGitIgnoreReadPolicy(context.Background(), "cat build/artifact.txt", dir, guard)
	if err == nil {
		t.Fatal("expected .gitignore path command to be blocked")
	}
	if !strings.Contains(err.Error(), ".gitignore") {
		t.Fatalf("expected .gitignore guidance, got %q", err.Error())
	}
}

func TestValidateGitIgnoreReadPolicy_AllowsNonIgnoredCommands(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "build/\n")
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	guard := newPathGuard(testWorkspace(dir))
	if err := validateGitIgnoreReadPolicy(context.Background(), "cat ./main.go", dir, guard); err != nil {
		t.Fatalf("expected command to be allowed: %v", err)
	}
}
