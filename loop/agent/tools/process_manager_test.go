package tools

import (
	"testing"
	"time"
)

func TestProcessManager_ExecCommand_BasicEcho(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()

	result, err := pm.ExecCommand([]string{"echo", "hello"}, "", nil, 5000)
	if err != nil {
		t.Fatalf("ExecCommand failed: %v", err)
	}

	if result.ExitCode == nil {
		t.Fatal("expected process to have exited")
	}
	if *result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", *result.ExitCode)
	}
	if result.Output == "" {
		t.Fatal("expected output")
	}
	// Process completed — no session ID.
	if result.ProcessID != "" {
		t.Fatalf("expected empty processID for completed process, got %q", result.ProcessID)
	}
}

func TestProcessManager_ExecCommand_LongRunning(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()

	// Start a long-running process with short yield time.
	result, err := pm.ExecCommand([]string{"sleep", "10"}, "", nil, 100)
	if err != nil {
		t.Fatalf("ExecCommand failed: %v", err)
	}

	// Process should still be running.
	if result.ProcessID == "" {
		t.Fatal("expected non-empty processID for running process")
	}
	if result.ExitCode != nil {
		t.Fatal("expected nil exit code for running process")
	}

	// Kill it.
	if err := pm.Kill(result.ProcessID); err != nil {
		t.Fatalf("Kill failed: %v", err)
	}
}

func TestProcessManager_WriteStdin(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()

	// Start a cat process (reads stdin, writes to stdout).
	result, err := pm.ExecCommand([]string{"cat"}, "", nil, 200)
	if err != nil {
		t.Fatalf("ExecCommand failed: %v", err)
	}

	if result.ProcessID == "" {
		t.Fatal("expected non-empty processID")
	}

	// Write to stdin.
	writeResult, err := pm.WriteStdin(result.ProcessID, "hello world\n", 500)
	if err != nil {
		t.Fatalf("WriteStdin failed: %v", err)
	}

	if writeResult.Output == "" {
		t.Fatal("expected output from cat after writing to stdin")
	}

	// Kill the cat process.
	_ = pm.Kill(result.ProcessID)
}

func TestProcessManager_WriteStdin_InvalidSession(t *testing.T) {
	pm := NewProcessManager()

	_, err := pm.WriteStdin("999", "hello", 100)
	if err == nil {
		t.Fatal("expected error for invalid session ID")
	}
}

func TestProcessManager_Kill_InvalidSession(t *testing.T) {
	pm := NewProcessManager()

	err := pm.Kill("999")
	if err == nil {
		t.Fatal("expected error for invalid session ID")
	}
}

func TestProcessManager_ExecCommand_WorkDir(t *testing.T) {
	pm := NewProcessManager()
	defer pm.Cleanup()

	result, err := pm.ExecCommand([]string{"pwd"}, "/tmp", nil, 5000)
	if err != nil {
		t.Fatalf("ExecCommand failed: %v", err)
	}

	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("expected exit code 0")
	}
}

func TestFormatExecResult_Completed(t *testing.T) {
	exitCode := 0
	r := &ExecResult{
		Output:   "hello world",
		ExitCode: &exitCode,
		WallTime: 1*time.Second + 500*time.Millisecond,
	}

	formatted := FormatExecResult(r)
	if formatted == "" {
		t.Fatal("expected non-empty formatted result")
	}
	// Should contain wall time.
	if !containsStr(formatted, "Wall time:") {
		t.Fatal("expected Wall time in output")
	}
	// Should contain exit code.
	if !containsStr(formatted, "Process exited with code 0") {
		t.Fatal("expected exit code in output")
	}
}

func TestFormatExecResult_Running(t *testing.T) {
	r := &ExecResult{
		ProcessID: "42",
		Output:    "partial output",
		WallTime:  250 * time.Millisecond,
	}

	formatted := FormatExecResult(r)
	if !containsStr(formatted, "Process running with session ID 42") {
		t.Fatal("expected session ID in output")
	}
}

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && findSubstring(s, substr))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
