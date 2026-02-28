package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestExecCommand_BasicEcho(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	args, _ := json.Marshal(map[string]any{
		"cmd":     "echo 'hello exec'",
		"workdir": dir,
	})

	result, err := handleExecCommand(context.Background(), args, pm, guard)
	if err != nil {
		t.Fatalf("handleExecCommand failed: %v", err)
	}

	var resp map[string]any
	json.Unmarshal(result, &resp)
	output := resp["output"].(string)

	if !strings.Contains(output, "hello exec") {
		t.Errorf("expected 'hello exec' in output, got %q", output)
	}
}

func TestExecCommand_LongRunningWithWriteStdin(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	// Start cat with a short yield time so we get back while it's running.
	yieldMs := int64(200)
	args, _ := json.Marshal(map[string]any{
		"cmd":           "cat",
		"yield_time_ms": yieldMs,
		"workdir":       dir,
	})

	execResult, err := handleExecCommand(context.Background(), args, pm, guard)
	if err != nil {
		t.Fatalf("handleExecCommand failed: %v", err)
	}

	var execResp map[string]any
	json.Unmarshal(execResult, &execResp)
	execOutput := execResp["output"].(string)

	if !strings.Contains(execOutput, "Process running with session ID") {
		t.Fatalf("expected running process, got %q", execOutput)
	}

	// Extract session ID from the format output.
	// Find the session ID number.
	sessionIDStr := ""
	for _, line := range strings.Split(execOutput, "\n") {
		if strings.HasPrefix(line, "Process running with session ID ") {
			sessionIDStr = strings.TrimPrefix(line, "Process running with session ID ")
			break
		}
	}
	if sessionIDStr == "" {
		t.Fatal("could not extract session ID")
	}

	// Parse session ID for write_stdin.
	sessionID := 0
	for _, c := range sessionIDStr {
		if c >= '0' && c <= '9' {
			sessionID = sessionID*10 + int(c-'0')
		}
	}

	// Write to stdin.
	writeArgs, _ := json.Marshal(map[string]any{
		"session_id":    sessionID,
		"chars":         "test input\n",
		"yield_time_ms": 500,
	})

	writeResult, err := handleWriteStdin(context.Background(), writeArgs, pm)
	if err != nil {
		t.Fatalf("handleWriteStdin failed: %v", err)
	}

	var writeResp map[string]any
	json.Unmarshal(writeResult, &writeResp)
	writeOutput := writeResp["output"].(string)

	if !strings.Contains(writeOutput, "test input") {
		t.Errorf("expected 'test input' echoed back from cat, got %q", writeOutput)
	}

	// Kill the process.
	_ = pm.Kill(sessionIDStr)
}

func TestExecCommand_EmptyCmd(t *testing.T) {
	pm := NewProcessManager()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	args, _ := json.Marshal(map[string]any{
		"cmd":     "",
		"workdir": dir,
	})

	_, err := handleExecCommand(context.Background(), args, pm, guard)
	if err == nil {
		t.Fatal("expected error for empty cmd")
	}
}
