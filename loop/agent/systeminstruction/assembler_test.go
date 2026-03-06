package systeminstruction

import (
	"strings"
	"testing"
)

func TestGet(t *testing.T) {
	prompt := Get()
	if prompt == "" {
		t.Fatal("expected assembled prompt to not be empty")
	}

	if len(prompt) < 100 {
		t.Fatalf("expected prompt to be substantial in size, got %d chars", len(prompt))
	}

	if !strings.Contains(prompt, "Output Contract") {
		t.Error("expected prompt to contain 'Output Contract'")
	}
	if !strings.Contains(prompt, "Task contract gate") {
		t.Error("expected prompt to contain task-contract routing guidance")
	}
	if !strings.Contains(prompt, "Capability ladder") {
		t.Error("expected prompt to contain capability ladder guidance")
	}
	if !strings.Contains(prompt, ".gitignore") {
		t.Error("expected prompt to contain .gitignore exclusion guidance")
	}
	if !strings.Contains(prompt, "preserve existing behavior unless the user asked to change it") {
		t.Error("expected prompt to contain behavior-preservation guidance")
	}
	if !strings.Contains(prompt, "do not oversell the implementation") {
		t.Error("expected prompt to contain implementation-accuracy guidance")
	}
	if !strings.Contains(prompt, "do not edit unrelated files") {
		t.Error("expected prompt to contain scope discipline guidance")
	}
	if !strings.Contains(prompt, "net effect") {
		t.Error("expected prompt to contain sequential-operation net-effect guidance")
	}
	if !strings.Contains(prompt, "actual verification level") {
		t.Error("expected prompt to contain verification-level guidance")
	}
}
