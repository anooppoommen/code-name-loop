package tools

import (
	"strings"
	"testing"
)

func TestValidateWorkspaceEditPolicy_BlocksMutatingCommands(t *testing.T) {
	cases := []string{
		"rm -f patch.diff",
		"cp /tmp/a.ts src/a.ts",
		"mkdir scripts",
		"sed -i 's/a/b/' src/app.ts",
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
		"npm run build",
		"echo done > /dev/null",
		"printf 'x' > /tmp/codex-scratch.txt",
	}

	for _, cmd := range cases {
		if err := validateWorkspaceEditPolicy(cmd); err != nil {
			t.Fatalf("expected command to be allowed: %q (err: %v)", cmd, err)
		}
	}
}
