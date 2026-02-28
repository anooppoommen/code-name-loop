package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"loop/agent"

	"google.golang.org/genai"
)

const (
	shellDefaultTimeoutMs = 120000 // 2 minutes
	shellMaxOutputBytes   = 100 * 1024
)

type shellArgs struct {
	Command   string `json:"command"`
	Workdir   string `json:"workdir,omitempty"`
	TimeoutMs *int64 `json:"timeout_ms,omitempty"`
}

// NewShellTool creates the shell_command tool.
func NewShellTool() *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name: "shell",
			Description: `Runs a shell command and returns its output.
- Always set the workdir param when using the shell function. Do not use cd unless absolutely necessary.`,
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"command": {
						Type:        genai.TypeString,
						Description: "The shell command to execute.",
					},
					"workdir": {
						Type:        genai.TypeString,
						Description: "The working directory to execute the command in.",
					},
					"timeout_ms": {
						Type:        genai.TypeInteger,
						Description: "The timeout for the command in milliseconds.",
					},
				},
				Required: []string{"command"},
			},
		},
		Handler: handleShell,
	}
}

func handleShell(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var a shellArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if strings.TrimSpace(a.Command) == "" {
		return nil, fmt.Errorf("command must not be empty")
	}

	timeoutMs := int64(shellDefaultTimeoutMs)
	if a.TimeoutMs != nil {
		timeoutMs = *a.TimeoutMs
	}

	timeout := time.Duration(timeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	shellCmd := buildShellCommand(a.Command)
	cmd := exec.CommandContext(ctx, shellCmd[0], shellCmd[1:]...)

	if a.Workdir != "" {
		cmd.Dir = a.Workdir
	}

	startTime := time.Now()
	output, err := cmd.CombinedOutput()
	wallTime := time.Since(startTime)

	// Truncate large output.
	if len(output) > shellMaxOutputBytes {
		output = output[:shellMaxOutputBytes]
	}

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() != nil {
			return json.Marshal(map[string]any{
				"error": fmt.Sprintf("command timed out after %dms", timeoutMs),
			})
		} else {
			return nil, fmt.Errorf("failed to execute command: %w", err)
		}
	}

	result := fmt.Sprintf("Wall time: %.4f seconds\nProcess exited with code %d\nOutput:\n%s",
		wallTime.Seconds(), exitCode, string(output))

	return json.Marshal(map[string]any{"output": result})
}

func buildShellCommand(command string) []string {
	if runtime.GOOS == "windows" {
		return []string{"powershell.exe", "-NoProfile", "-Command", command}
	}
	return []string{"bash", "-lc", command}
}
