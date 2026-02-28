package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"google.golang.org/genai"
)

// ToolHandler is a function that executes a tool call given JSON arguments
// and returns a JSON result.
type ToolHandler func(ctx context.Context, args json.RawMessage) (json.RawMessage, error)

// ToolDef defines a tool available to the agent, including its Gemini
// function declaration, execution handler, and intent hints.
type ToolDef struct {
	// Declaration is the genai FunctionDeclaration describing the tool's
	// name, description, and parameters.
	Declaration *genai.FunctionDeclaration
	// Handler is the function that executes the tool call.
	Handler ToolHandler
	// Intents provides contextual hints that get patched into the tool's
	// description before sending to the model. This addresses Gemini's
	// tendency to misunderstand when/why to use a tool.
	//
	// Example:
	//   Intents: []string{
	//       "Use when the user asks to read a file",
	//       "Prefer this over shell commands for file reading",
	//   }
	Intents []string
}

// ToolRegistry is a map from tool name to its definition.
type ToolRegistry map[string]*ToolDef

// NewToolRegistry creates a registry from a slice of tool definitions.
func NewToolRegistry(defs []*ToolDef) ToolRegistry {
	reg := make(ToolRegistry, len(defs))
	for _, def := range defs {
		if def.Declaration != nil {
			reg[def.Declaration.Name] = def
		}
	}
	return reg
}

// BuildToolsForModel composes each tool's Intents into its description
// string and builds the genai.Tool declarations ready for the API.
// The original ToolDef descriptions are NOT mutated.
func BuildToolsForModel(defs []*ToolDef) []*genai.Tool {
	if len(defs) == 0 {
		return nil
	}

	var declarations []*genai.FunctionDeclaration
	for _, def := range defs {
		if def.Declaration == nil {
			continue
		}

		// Clone the declaration to avoid mutating the original.
		decl := &genai.FunctionDeclaration{
			Name:        def.Declaration.Name,
			Description: def.Declaration.Description,
			Parameters:  def.Declaration.Parameters,
		}

		// Patch intents into the description.
		if len(def.Intents) > 0 {
			var sb strings.Builder
			sb.WriteString(decl.Description)
			sb.WriteString("\n\nWhen to use:\n")
			for _, intent := range def.Intents {
				sb.WriteString("- ")
				sb.WriteString(intent)
				sb.WriteString("\n")
			}
			decl.Description = sb.String()
		}

		declarations = append(declarations, decl)
	}

	return []*genai.Tool{
		{FunctionDeclarations: declarations},
	}
}

// ToolCallRequest represents a single tool call to execute.
type ToolCallRequest struct {
	CallID string
	Name   string
	Args   json.RawMessage
}

// ToolCallResponse represents the result of executing a tool call.
type ToolCallResponse struct {
	CallID       string
	Name         string
	ResponseJSON json.RawMessage
	Err          error
}

// ExecuteToolCalls runs the given tool calls against the registry,
// executing them concurrently when there are multiple independent calls.
// Returns responses in the same order as the input calls.
func ExecuteToolCalls(ctx context.Context, calls []ToolCallRequest, registry ToolRegistry) []ToolCallResponse {
	responses := make([]ToolCallResponse, len(calls))

	if len(calls) == 1 {
		// Fast path: single call, no goroutine overhead.
		responses[0] = executeSingleCall(ctx, calls[0], registry)
		return responses
	}

	// Parallel execution for multiple calls.
	var wg sync.WaitGroup
	for i, call := range calls {
		wg.Add(1)
		go func(idx int, c ToolCallRequest) {
			defer wg.Done()
			responses[idx] = executeSingleCall(ctx, c, registry)
		}(i, call)
	}
	wg.Wait()
	return responses
}

func executeSingleCall(ctx context.Context, call ToolCallRequest, registry ToolRegistry) ToolCallResponse {
	resp := ToolCallResponse{
		CallID: call.CallID,
		Name:   call.Name,
	}

	def, ok := registry[call.Name]
	if !ok {
		resp.Err = fmt.Errorf("unknown tool: %s", call.Name)
		resp.ResponseJSON = json.RawMessage(fmt.Sprintf(`{"error":"unknown tool: %s"}`, call.Name))
		return resp
	}

	result, err := def.Handler(ctx, call.Args)
	if err != nil {
		resp.Err = err
		resp.ResponseJSON = json.RawMessage(fmt.Sprintf(`{"error":%q}`, err.Error()))
		return resp
	}

	resp.ResponseJSON = result
	return resp
}
