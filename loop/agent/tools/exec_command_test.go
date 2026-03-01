package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
		"tty":           true,
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

func TestExecCommand_NonTTYClosesStdin(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	yieldMs := int64(500)
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

	if strings.Contains(execOutput, "Process running with session ID") {
		t.Fatalf("expected cat to exit with closed stdin, got %q", execOutput)
	}
	if !strings.Contains(execOutput, "Process exited with code 0") {
		t.Fatalf("expected cat to exit cleanly on EOF, got %q", execOutput)
	}
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

func TestExecCommand_BlocksWorkspaceMutationCommands(t *testing.T) {
	pm := NewProcessManager()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	args, _ := json.Marshal(map[string]any{
		"cmd":     "cat << 'EOF' > patch.diff\nx\nEOF",
		"workdir": dir,
	})

	_, err := handleExecCommand(context.Background(), args, pm, guard)
	if err == nil {
		t.Fatal("expected write-style command to be blocked")
	}
}

func TestExecCommand_BlocksGitIgnoredPathReads(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	initGitRepo(t, dir)
	writeGitignore(t, dir, "build/\n")
	if err := os.MkdirAll(filepath.Join(dir, "build"), 0o755); err != nil {
		t.Fatalf("mkdir build: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "build", "artifact.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	guard := newPathGuard(testWorkspace(dir))

	args, _ := json.Marshal(map[string]any{
		"cmd":     "cat build/artifact.txt",
		"workdir": dir,
	})

	_, err := handleExecCommand(context.Background(), args, pm, guard)
	if err == nil {
		t.Fatal("expected ignored-path read command to be blocked")
	}
	if !strings.Contains(err.Error(), ".gitignore") {
		t.Fatalf("expected .gitignore message, got %v", err)
	}
}

func TestExecCommand_CommandApprovalDenied(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	requestCount := 0
	requester := CommandApprovalRequesterFunc(func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error) {
		requestCount++
		return CommandApprovalResolution{
			Decision: CommandApprovalDecisionDeny,
			Message:  "denied for safety",
		}, nil
	})

	args, _ := json.Marshal(map[string]any{
		"cmd":     "echo blocked",
		"workdir": dir,
	})

	_, err := handleExecCommand(context.Background(), args, pm, guard, requester)
	if err == nil {
		t.Fatal("expected denial error")
	}
	if !strings.Contains(err.Error(), "denied by user") {
		t.Fatalf("expected denial message, got %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("approval requester called %d times, want 1", requestCount)
	}
}

func TestExecCommand_CommandApprovalAllowOnce(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	requestCount := 0
	requester := CommandApprovalRequesterFunc(func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error) {
		requestCount++
		return CommandApprovalResolution{Decision: CommandApprovalDecisionAllowOnce}, nil
	})

	args, _ := json.Marshal(map[string]any{
		"cmd":     "echo approved",
		"workdir": dir,
	})

	result, err := handleExecCommand(context.Background(), args, pm, guard, requester)
	if err != nil {
		t.Fatalf("handleExecCommand: %v", err)
	}
	var resp map[string]any
	if err := json.Unmarshal(result, &resp); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	output, _ := resp["output"].(string)
	if !strings.Contains(output, "approved") {
		t.Fatalf("expected approved output, got %q", output)
	}
	if requestCount != 1 {
		t.Fatalf("approval requester called %d times, want 1", requestCount)
	}
}
