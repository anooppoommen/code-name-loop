package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"loop/agent"

	"google.golang.org/genai"
)

const maxParallelToolUses = 8
const minParallelToolUses = 2

type parallelToolUseArgs struct {
	ToolUses []parallelToolUseItem `json:"tool_uses"`
}

type parallelToolUseItem struct {
	Name          string         `json:"name,omitempty"`
	Arguments     map[string]any `json:"arguments,omitempty"`
	RecipientName string         `json:"recipient_name,omitempty"`
	Parameters    map[string]any `json:"parameters,omitempty"`
}

type parallelToolUseResult struct {
	Name      string          `json:"name"`
	Success   bool            `json:"success"`
	Arguments map[string]any  `json:"arguments,omitempty"`
	Response  json.RawMessage `json:"response,omitempty"`
	Error     string          `json:"error,omitempty"`
}

var parallelToolDisallowed = map[string]struct{}{
	"parallel_tool_use": {},
	"apply_patch":       {},
	"write_stdin":       {},
	"spawn_thread":      {},
	"await_thread":      {},
}

// NewParallelToolUseTool creates a batching helper for concurrent read-oriented tool invocations.
func NewParallelToolUseTool(toolDefsProvider func() []*agent.ToolDef) *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name: "parallel_tool_use",
			Description: `Runs multiple tool calls concurrently and returns ordered results.
Use this when you have 2 or more independent read-oriented calls to run at the same time, including early repo discovery bursts.
This tool is invalid for a single call; call the tool directly instead.
Do not use as a default wrapper for sequential dependent work.
Do not include stateful tools (apply_patch, write_stdin, thread-control tools).`,
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"tool_uses": {
						Type:        genai.TypeArray,
						Description: "Tool invocations to run in parallel.",
						Items: &genai.Schema{
							Type: genai.TypeObject,
							Properties: map[string]*genai.Schema{
								"name": {
									Type:        genai.TypeString,
									Description: "Registered tool name to invoke.",
								},
								"recipient_name": {
									Type:        genai.TypeString,
									Description: "Alternative tool identifier (namespaced form allowed).",
								},
								"arguments": {
									Type:        genai.TypeObject,
									Description: "Arguments object for the target tool.",
								},
								"parameters": {
									Type:        genai.TypeObject,
									Description: "Alternative field for target tool arguments.",
								},
							},
						},
					},
				},
				Required: []string{"tool_uses"},
			},
		},
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			defs := toolDefsProvider()
			if len(defs) == 0 {
				return nil, fmt.Errorf("no tools available for parallel execution")
			}
			return handleParallelToolUse(ctx, args, agent.NewToolRegistry(defs))
		},
		Intents: []string{
			"Use when you already know multiple independent read-only calls are needed",
			"Use for early targeted discovery when 2 to 4 obvious reads/searches will narrow the task quickly",
			"Prefer this over sequential calls for independent file/search reads",
			"Do not use for single-call flows or for steps where one result determines the next call",
		},
	}
}

func handleParallelToolUse(ctx context.Context, args json.RawMessage, registry agent.ToolRegistry) (json.RawMessage, error) {
	var a parallelToolUseArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if len(a.ToolUses) < minParallelToolUses {
		return nil, fmt.Errorf("tool_uses must contain at least %d items for parallel execution", minParallelToolUses)
	}
	if len(a.ToolUses) > maxParallelToolUses {
		return nil, fmt.Errorf("tool_uses length exceeds max of %d", maxParallelToolUses)
	}

	results := make([]parallelToolUseResult, len(a.ToolUses))
	var wg sync.WaitGroup

	for i, call := range a.ToolUses {
		wg.Add(1)
		go func(idx int, invocation parallelToolUseItem) {
			defer wg.Done()
			results[idx] = runParallelInvocation(ctx, invocation, registry)
		}(i, call)
	}

	wg.Wait()

	successCount := 0
	for _, r := range results {
		if r.Success {
			successCount++
		}
	}

	usedNames := make([]string, 0, len(a.ToolUses))
	for _, item := range a.ToolUses {
		n := normalizeParallelToolName(item.Name, item.RecipientName)
		if n == "" {
			n = "<invalid>"
		}
		usedNames = append(usedNames, n)
	}
	sort.Strings(usedNames)

	return json.Marshal(map[string]any{
		"results":           results,
		"total":             len(results),
		"success_count":     successCount,
		"failure_count":     len(results) - successCount,
		"requested_tools":   usedNames,
		"all_success":       successCount == len(results),
		"max_parallel_uses": maxParallelToolUses,
	})
}

func runParallelInvocation(ctx context.Context, invocation parallelToolUseItem, registry agent.ToolRegistry) parallelToolUseResult {
	name := normalizeParallelToolName(invocation.Name, invocation.RecipientName)
	if name == "" {
		return parallelToolUseResult{Name: name, Success: false, Error: "name or recipient_name is required"}
	}

	if _, blocked := parallelToolDisallowed[name]; blocked {
		return parallelToolUseResult{Name: name, Success: false, Error: fmt.Sprintf("%s is not allowed in parallel_tool_use", name)}
	}

	def, ok := registry[name]
	if !ok || def == nil || def.Handler == nil {
		return parallelToolUseResult{Name: name, Success: false, Error: fmt.Sprintf("unknown tool: %s", name)}
	}

	argPayload := invocation.Arguments
	if len(argPayload) == 0 && invocation.Parameters != nil {
		argPayload = invocation.Parameters
	}
	if argPayload == nil {
		argPayload = map[string]any{}
	}
	rawArgs, err := json.Marshal(argPayload)
	if err != nil {
		return parallelToolUseResult{Name: name, Success: false, Error: fmt.Sprintf("failed to serialize arguments: %v", err)}
	}

	out, err := def.Handler(ctx, rawArgs)
	if err != nil {
		return parallelToolUseResult{Name: name, Success: false, Arguments: argPayload, Error: err.Error()}
	}

	return parallelToolUseResult{Name: name, Success: true, Arguments: argPayload, Response: out}
}

func normalizeParallelToolName(name, recipient string) string {
	trimmed := name
	if strings.TrimSpace(trimmed) == "" {
		trimmed = recipient
	}
	trimmed = strings.TrimSpace(trimmed)
	if trimmed == "" {
		return ""
	}
	parts := strings.Split(trimmed, ".")
	return strings.TrimSpace(parts[len(parts)-1])
}
