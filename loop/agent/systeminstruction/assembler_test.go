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
}
