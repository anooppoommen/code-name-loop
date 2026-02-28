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
}
