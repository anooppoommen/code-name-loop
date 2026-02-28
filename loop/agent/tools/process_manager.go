package tools

import (
	"bytes"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// ManagedProcess represents a background process managed by the ProcessManager.
type ManagedProcess struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	output    *safeBuffer
	exitCode  *int
	exitErr   error
	done      chan struct{}
	startTime time.Time
}

// safeBuffer is a thread-safe bytes.Buffer for concurrent reads/writes.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) ReadAndReset() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.buf.String()
	b.buf.Reset()
	return s
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// ProcessManager manages background processes with session IDs.
// Manages unified execution processes.
type ProcessManager struct {
	mu        sync.RWMutex
	processes map[string]*ManagedProcess
	nextID    atomic.Int64
}

// NewProcessManager creates a new ProcessManager.
func NewProcessManager() *ProcessManager {
	return &ProcessManager{
		processes: make(map[string]*ManagedProcess),
	}
}

// ExecResult is the return value from ExecCommand.
type ExecResult struct {
	ProcessID string
	Output    string
	ExitCode  *int
	WallTime  time.Duration
}

// ExecCommand spawns a new background process and returns the initial output.
func (pm *ProcessManager) ExecCommand(
	command []string,
	cwd string,
	env []string,
	yieldTimeMs int64,
) (*ExecResult, error) {
	if len(command) == 0 {
		return nil, fmt.Errorf("command must not be empty")
	}

	processID := fmt.Sprintf("%d", pm.nextID.Add(1))

	cmd := exec.Command(command[0], command[1:]...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	if len(env) > 0 {
		cmd.Env = env
	}

	output := &safeBuffer{}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	cmd.Stdout = output
	cmd.Stderr = output

	startTime := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start command: %w", err)
	}

	mp := &ManagedProcess{
		cmd:       cmd,
		stdin:     stdin,
		output:    output,
		done:      make(chan struct{}),
		startTime: startTime,
	}

	// Monitor the process in the background.
	go func() {
		defer close(mp.done)
		err := cmd.Wait()
		mp.exitErr = err
		code := cmd.ProcessState.ExitCode()
		mp.exitCode = &code
	}()

	pm.mu.Lock()
	pm.processes[processID] = mp
	pm.mu.Unlock()

	// Wait yieldTimeMs for initial output.
	yieldDuration := time.Duration(yieldTimeMs) * time.Millisecond
	select {
	case <-mp.done:
		// Process finished.
	case <-time.After(yieldDuration):
		// Yield timeout — process still running.
	}

	wallTime := time.Since(startTime)
	result := &ExecResult{
		ProcessID: processID,
		Output:    output.ReadAndReset(),
		ExitCode:  mp.exitCode,
		WallTime:  wallTime,
	}

	// If process finished, clean up.
	if mp.exitCode != nil {
		pm.mu.Lock()
		delete(pm.processes, processID)
		pm.mu.Unlock()
		result.ProcessID = ""
	}

	return result, nil
}

// WriteStdinResult is the return value from WriteStdin.
type WriteStdinResult struct {
	Output   string
	ExitCode *int
	WallTime time.Duration
}

// WriteStdin writes to the stdin of a running process and returns buffered output.
func (pm *ProcessManager) WriteStdin(
	processID string,
	input string,
	yieldTimeMs int64,
) (*WriteStdinResult, error) {
	pm.mu.RLock()
	mp, ok := pm.processes[processID]
	pm.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("no process with session ID %s", processID)
	}

	startTime := time.Now()

	// Write input to stdin.
	if input != "" {
		if _, err := io.WriteString(mp.stdin, input); err != nil {
			return nil, fmt.Errorf("failed to write to stdin: %w", err)
		}
	}

	// Wait yieldTimeMs for output.
	yieldDuration := time.Duration(yieldTimeMs) * time.Millisecond
	select {
	case <-mp.done:
		// Process finished.
	case <-time.After(yieldDuration):
		// Yield timeout.
	}

	wallTime := time.Since(startTime)
	result := &WriteStdinResult{
		Output:   mp.output.ReadAndReset(),
		ExitCode: mp.exitCode,
		WallTime: wallTime,
	}

	// Clean up if finished.
	if mp.exitCode != nil {
		pm.mu.Lock()
		delete(pm.processes, processID)
		pm.mu.Unlock()
	}

	return result, nil
}

// Kill terminates a running process.
func (pm *ProcessManager) Kill(processID string) error {
	pm.mu.Lock()
	mp, ok := pm.processes[processID]
	if !ok {
		pm.mu.Unlock()
		return fmt.Errorf("no process with session ID %s", processID)
	}
	delete(pm.processes, processID)
	pm.mu.Unlock()

	if mp.cmd.Process != nil {
		return mp.cmd.Process.Kill()
	}
	return nil
}

// Cleanup kills all still-running processes. Call on shutdown.
func (pm *ProcessManager) Cleanup() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	for id, mp := range pm.processes {
		if mp.cmd.Process != nil {
			_ = mp.cmd.Process.Kill()
		}
		delete(pm.processes, id)
	}
}

// FormatExecResult formats an ExecResult.
func FormatExecResult(r *ExecResult) string {
	var sections []string

	wallSec := r.WallTime.Seconds()
	sections = append(sections, fmt.Sprintf("Wall time: %.4f seconds", wallSec))

	if r.ExitCode != nil {
		sections = append(sections, fmt.Sprintf("Process exited with code %d", *r.ExitCode))
	}

	if r.ProcessID != "" {
		sections = append(sections, fmt.Sprintf("Process running with session ID %s", r.ProcessID))
	}

	sections = append(sections, "Output:")
	sections = append(sections, r.Output)

	result := ""
	for i, s := range sections {
		if i > 0 {
			result += "\n"
		}
		result += s
	}
	return result
}

// FormatWriteStdinResult formats a WriteStdinResult.
func FormatWriteStdinResult(r *WriteStdinResult, processID string) string {
	var sections []string

	wallSec := r.WallTime.Seconds()
	sections = append(sections, fmt.Sprintf("Wall time: %.4f seconds", wallSec))

	if r.ExitCode != nil {
		sections = append(sections, fmt.Sprintf("Process exited with code %d", *r.ExitCode))
	} else {
		sections = append(sections, fmt.Sprintf("Process running with session ID %s", processID))
	}

	sections = append(sections, "Output:")
	sections = append(sections, r.Output)

	result := ""
	for i, s := range sections {
		if i > 0 {
			result += "\n"
		}
		result += s
	}
	return result
}
