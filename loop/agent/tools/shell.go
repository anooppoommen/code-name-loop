package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"loop/agent"
	"loop/models"

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
func NewShellTool(pm *ProcessManager, ws *models.Workspace) *agent.ToolDef {
	guard := newPathGuard(ws)
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name: "shell",
			Description: `Runs diagnostic or verification shell commands and returns output.
- Always set the workdir param when using the shell function. Do not use cd unless absolutely necessary.
- Prefer structured repository tools (read/search/list equivalents) for local code inspection before using shell.
- Do not use shell to create/edit/delete workspace files. Use apply_patch for all workspace file edits.
- If the command does not finish before timeout_ms, this tool returns an error plus session_id and partial combined stdout/stderr. Use write_stdin with chars="" and that session_id to poll more output.`,
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
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return handleShell(ctx, args, pm, guard)
		},
		Intents: []string{
			"Use for quick read-only diagnostics when exec_command is not required",
			"Use for verification commands (build/test/lint) after patching if needed",
			"Prefer structured read/search/list tools for code inspection when available",
			"Never use for writing workspace files; apply_patch is mandatory for edits",
			"If blocked by workspace edit policy, switch to apply_patch instead of retrying shell mutation",
		},
	}
}

func handleShell(_ context.Context, args json.RawMessage, pm *ProcessManager, guard *pathGuard) (json.RawMessage, error) {
	var a shellArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if strings.TrimSpace(a.Command) == "" {
		return nil, fmt.Errorf("command must not be empty")
	}
	if err := validateWorkspaceEditPolicy(a.Command); err != nil {
		return nil, err
	}

	timeoutMs := int64(shellDefaultTimeoutMs)
	if a.TimeoutMs != nil {
		timeoutMs = *a.TimeoutMs
	}

	workdir, err := guard.requireAllowedWorkdir(a.Workdir)
	if err != nil {
		return nil, err
	}
	command := buildExecCommand(a.Command, "")
	result, err := pm.ExecCommand(command, workdir, nil, timeoutMs, false)
	if err != nil {
		return nil, fmt.Errorf("failed to execute command: %w", err)
	}
	if len(result.Output) > shellMaxOutputBytes {
		result.Output = result.Output[:shellMaxOutputBytes]
	}
	formatted := FormatExecResult(result)

	// Keep long-running processes alive for follow-up debugging via write_stdin.
	if result.ExitCode == nil && result.ProcessID != "" {
		resp := map[string]any{
			"error":     fmt.Sprintf("command timed out after %dms", timeoutMs),
			"output":    formatted,
			"next_step": "Use write_stdin with chars=\"\" to poll more combined stdout/stderr from this running process.",
		}
		if sid, convErr := strconv.Atoi(result.ProcessID); convErr == nil {
			resp["session_id"] = sid
		}
		return json.Marshal(resp)
	}

	return json.Marshal(map[string]any{"output": formatted})
}
