package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"

	"loop/agent"

	"google.golang.org/genai"
)

const (
	defaultExecYieldTimeMs       = 10000
	defaultWriteStdinYieldTimeMs = 250
)

type execCommandArgs struct {
	Cmd             string `json:"cmd"`
	Workdir         string `json:"workdir,omitempty"`
	Shell           string `json:"shell,omitempty"`
	Tty             bool   `json:"tty,omitempty"`
	YieldTimeMs     *int64 `json:"yield_time_ms,omitempty"`
	MaxOutputTokens *int   `json:"max_output_tokens,omitempty"`
}

type writeStdinArgs struct {
	SessionID       int    `json:"session_id"`
	Chars           string `json:"chars"`
	YieldTimeMs     *int64 `json:"yield_time_ms,omitempty"`
	MaxOutputTokens *int   `json:"max_output_tokens,omitempty"`
}

// NewExecCommandTool creates the exec_command tool.
func NewExecCommandTool(pm *ProcessManager) *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name:        "exec_command",
			Description: "Runs a command in a shell, returning output or a session ID for ongoing interaction.",
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"cmd": {
						Type:        genai.TypeString,
						Description: "Shell command to execute.",
					},
					"workdir": {
						Type:        genai.TypeString,
						Description: "Optional working directory to run the command in.",
					},
					"shell": {
						Type:        genai.TypeString,
						Description: "Shell binary to launch. Defaults to the user's default shell.",
					},
					"tty": {
						Type:        genai.TypeBoolean,
						Description: "Whether to allocate a TTY for the command. Defaults to false.",
					},
					"yield_time_ms": {
						Type:        genai.TypeInteger,
						Description: "How long to wait (in milliseconds) for output before yielding.",
					},
					"max_output_tokens": {
						Type:        genai.TypeInteger,
						Description: "Maximum number of tokens to return. Excess output will be truncated.",
					},
				},
				Required: []string{"cmd"},
			},
		},
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return handleExecCommand(ctx, args, pm)
		},
	}
}

// NewWriteStdinTool creates the write_stdin tool.
func NewWriteStdinTool(pm *ProcessManager) *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name:        "write_stdin",
			Description: "Writes characters to an existing exec session and returns recent output.",
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"session_id": {
						Type:        genai.TypeInteger,
						Description: "Identifier of the running exec session.",
					},
					"chars": {
						Type:        genai.TypeString,
						Description: "Bytes to write to stdin (may be empty to poll).",
					},
					"yield_time_ms": {
						Type:        genai.TypeInteger,
						Description: "How long to wait (in milliseconds) for output before yielding.",
					},
					"max_output_tokens": {
						Type:        genai.TypeInteger,
						Description: "Maximum number of tokens to return.",
					},
				},
				Required: []string{"session_id"},
			},
		},
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return handleWriteStdin(ctx, args, pm)
		},
	}
}

func handleExecCommand(_ context.Context, args json.RawMessage, pm *ProcessManager) (json.RawMessage, error) {
	var a execCommandArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if strings.TrimSpace(a.Cmd) == "" {
		return nil, fmt.Errorf("cmd must not be empty")
	}

	yieldMs := int64(defaultExecYieldTimeMs)
	if a.YieldTimeMs != nil {
		yieldMs = *a.YieldTimeMs
	}

	command := buildExecCommand(a.Cmd, a.Shell)

	result, err := pm.ExecCommand(command, a.Workdir, nil, yieldMs)
	if err != nil {
		return nil, err
	}

	return json.Marshal(map[string]any{"output": FormatExecResult(result)})
}

func handleWriteStdin(_ context.Context, args json.RawMessage, pm *ProcessManager) (json.RawMessage, error) {
	var a writeStdinArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	processID := fmt.Sprintf("%d", a.SessionID)
	yieldMs := int64(defaultWriteStdinYieldTimeMs)
	if a.YieldTimeMs != nil {
		yieldMs = *a.YieldTimeMs
	}

	result, err := pm.WriteStdin(processID, a.Chars, yieldMs)
	if err != nil {
		return nil, err
	}

	return json.Marshal(map[string]any{"output": FormatWriteStdinResult(result, processID)})
}

func buildExecCommand(cmd string, shell string) []string {
	if shell != "" {
		return []string{shell, "-c", cmd}
	}
	if runtime.GOOS == "windows" {
		return []string{"powershell.exe", "-NoProfile", "-Command", cmd}
	}
	return []string{"bash", "-lc", cmd}
}
