package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShell_EchoCommand(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	args, _ := json.Marshal(map[string]any{
		"command": "echo 'hello world'",
		"workdir": dir,
	})

	result, err := handleShell(context.Background(), args, guard)
	if err != nil {
		t.Fatalf("handleShell failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output, ok := resp["output"].(string)
	if !ok {
		t.Fatal("expected output field")
	}

	if !strings.Contains(output, "hello world") {
		t.Errorf("expected 'hello world' in output, got %q", output)
	}
	if !strings.Contains(output, "Process exited with code 0") {
		t.Errorf("expected exit code 0 in output")
	}
}

func TestShell_NonZeroExit(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	args, _ := json.Marshal(map[string]any{
		"command": "exit 42",
		"workdir": dir,
	})

	result, err := handleShell(context.Background(), args, guard)
	if err != nil {
		t.Fatalf("handleShell failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "Process exited with code 42") {
		t.Errorf("expected exit code 42 in output, got %q", output)
	}
}

func TestShell_WorkDir(t *testing.T) {
	dir := t.TempDir()
	workdir := filepath.Join(dir, "nested")
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	guard := newPathGuard(testWorkspace(dir))

	args, _ := json.Marshal(map[string]any{
		"command": "pwd",
		"workdir": workdir,
	})

	result, err := handleShell(context.Background(), args, guard)
	if err != nil {
		t.Fatalf("handleShell failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "nested") {
		t.Errorf("expected workdir path in output, got %q", output)
	}
}

func TestShell_EmptyCommand(t *testing.T) {
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	args, _ := json.Marshal(map[string]any{
		"command": "",
		"workdir": dir,
	})

	_, err := handleShell(context.Background(), args, guard)
	if err == nil {
		t.Fatal("expected error for empty command")
	}
}
