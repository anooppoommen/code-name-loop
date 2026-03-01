package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestShell_EchoCommand(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	args, _ := json.Marshal(map[string]any{
		"command": "echo 'hello world'",
		"workdir": dir,
	})

	result, err := handleShell(context.Background(), args, pm, guard)
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
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	args, _ := json.Marshal(map[string]any{
		"command": "exit 42",
		"workdir": dir,
	})

	result, err := handleShell(context.Background(), args, pm, guard)
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
	pm := NewProcessManager()
	defer pm.Cleanup()
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

	result, err := handleShell(context.Background(), args, pm, guard)
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
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	args, _ := json.Marshal(map[string]any{
		"command": "",
		"workdir": dir,
	})

	_, err := handleShell(context.Background(), args, pm, guard)
	if err == nil {
		t.Fatal("expected error for empty command")
	}
}

func TestShell_TimeoutReturnsSessionForDebugging(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	timeoutMs := int64(250)
	args, _ := json.Marshal(map[string]any{
		"command":    "echo begin; echo oops 1>&2; sleep 5",
		"workdir":    dir,
		"timeout_ms": timeoutMs,
	})

	result, err := handleShell(context.Background(), args, pm, guard)
	if err != nil {
		t.Fatalf("handleShell failed: %v", err)
	}

	var resp map[string]any
	if err := json.Unmarshal(result, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	errText, ok := resp["error"].(string)
	if !ok {
		t.Fatalf("expected timeout error response, got: %s", string(result))
	}
	if !strings.Contains(errText, "timed out") {
		t.Fatalf("expected timeout error, got: %q", errText)
	}

	output, ok := resp["output"].(string)
	if !ok {
		t.Fatalf("expected output in timeout response, got: %s", string(result))
	}
	if !strings.Contains(output, "begin") {
		t.Fatalf("expected partial output to include command stdout, got: %q", output)
	}
	if !strings.Contains(output, "oops") {
		t.Fatalf("expected partial output to include command stderr, got: %q", output)
	}

	sessionAny, ok := resp["session_id"]
	if !ok {
		t.Fatalf("expected session_id in timeout response, got: %s", string(result))
	}
	sessionIDFloat, ok := sessionAny.(float64)
	if !ok {
		t.Fatalf("expected numeric session_id, got: %#v", sessionAny)
	}
	sessionID := int(sessionIDFloat)

	writeArgs, _ := json.Marshal(map[string]any{
		"session_id":    sessionID,
		"chars":         "",
		"yield_time_ms": 50,
	})
	writeResult, err := handleWriteStdin(context.Background(), writeArgs, pm)
	if err != nil {
		t.Fatalf("handleWriteStdin failed: %v", err)
	}
	var writeResp map[string]any
	if err := json.Unmarshal(writeResult, &writeResp); err != nil {
		t.Fatalf("unmarshal write response: %v", err)
	}
	writeOutput, ok := writeResp["output"].(string)
	if !ok {
		t.Fatalf("expected output from write_stdin, got: %s", string(writeResult))
	}
	if !strings.Contains(writeOutput, "Process running with session ID") {
		t.Fatalf("expected running session status in write_stdin output, got: %q", writeOutput)
	}

	if err := pm.Kill(strconv.Itoa(sessionID)); err != nil {
		t.Fatalf("kill timed-out shell process: %v", err)
	}
}

func TestShell_BlocksWorkspaceMutationCommands(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))
	args, _ := json.Marshal(map[string]any{
		"command": "cp /tmp/a.ts src/a.ts",
		"workdir": dir,
	})

	_, err := handleShell(context.Background(), args, pm, guard)
	if err == nil {
		t.Fatal("expected mutation command to be blocked")
	}
}

func TestShell_BlocksGitIgnoredPathReads(t *testing.T) {
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
		"command": "cat build/artifact.txt",
		"workdir": dir,
	})

	_, err := handleShell(context.Background(), args, pm, guard)
	if err == nil {
		t.Fatal("expected ignored-path read command to be blocked")
	}
	if !strings.Contains(err.Error(), ".gitignore") {
		t.Fatalf("expected .gitignore message, got %v", err)
	}
}

func TestShell_CommandApprovalDenied(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()
	dir := t.TempDir()
	guard := newPathGuard(testWorkspace(dir))

	requester := CommandApprovalRequesterFunc(func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error) {
		return CommandApprovalResolution{
			Decision: CommandApprovalDecisionDeny,
			Message:  "blocked by user policy",
		}, nil
	})

	args, _ := json.Marshal(map[string]any{
		"command": "echo denied",
		"workdir": dir,
	})

	_, err := handleShell(context.Background(), args, pm, guard, requester)
	if err == nil {
		t.Fatal("expected denial error")
	}
	if !strings.Contains(err.Error(), "denied by user") {
		t.Fatalf("expected denial message, got %v", err)
	}
}
