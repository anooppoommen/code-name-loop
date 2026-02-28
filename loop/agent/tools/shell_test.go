package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestShell_EchoCommand(t *testing.T) {
	args, _ := json.Marshal(map[string]any{
		"command": "echo 'hello world'",
	})

	result, err := handleShell(context.Background(), args)
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
	args, _ := json.Marshal(map[string]any{
		"command": "exit 42",
	})

	result, err := handleShell(context.Background(), args)
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
	args, _ := json.Marshal(map[string]any{
		"command": "pwd",
		"workdir": "/tmp",
	})

	result, err := handleShell(context.Background(), args)
	if err != nil {
		t.Fatalf("handleShell failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	// /tmp may resolve to /private/tmp on macOS.
	if !strings.Contains(output, "tmp") {
		t.Errorf("expected '/tmp' in output, got %q", output)
	}
}

func TestShell_EmptyCommand(t *testing.T) {
	args, _ := json.Marshal(map[string]any{
		"command": "",
	})

	_, err := handleShell(context.Background(), args)
	if err == nil {
		t.Fatal("expected error for empty command")
	}
}
