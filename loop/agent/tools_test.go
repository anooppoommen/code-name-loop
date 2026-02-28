package agent_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"loop/agent"

	"google.golang.org/genai"
)

// ─────────────────────────────────────────────────────────────────
// Tool Framework Tests
// ─────────────────────────────────────────────────────────────────

func TestBuildToolsForModelIntentPatching(t *testing.T) {
	readDecl := genaiDecl("read_file", "Read a file from disk")
	writeDecl := genaiDecl("write_file", "Write content to a file")
	defs := []*agent.ToolDef{
		{
			Declaration: &readDecl,
			Intents: []string{
				"Use when the user asks to read or view a file",
				"Prefer this over shell commands for file reading",
			},
		},
		{
			Declaration: &writeDecl,
			Intents:     nil, // no intents
		},
	}

	tools := agent.BuildToolsForModel(defs)
	if len(tools) != 1 {
		t.Fatalf("tools count = %d, want 1", len(tools))
	}

	decls := tools[0].FunctionDeclarations
	if len(decls) != 2 {
		t.Fatalf("declarations count = %d, want 2", len(decls))
	}

	// read_file should have intents patched into description.
	if !strings.Contains(decls[0].Description, "When to use:") {
		t.Error("read_file description should contain 'When to use:'")
	}
	if !strings.Contains(decls[0].Description, "Prefer this over shell commands") {
		t.Error("read_file description should contain intent text")
	}

	// write_file should have original description unchanged.
	if decls[1].Description != "Write content to a file" {
		t.Errorf("write_file description = %q, want original", decls[1].Description)
	}
}

func TestBuildToolsForModelDoesNotMutateDefs(t *testing.T) {
	decl := genaiDecl("test_tool", "Original description")
	defs := []*agent.ToolDef{
		{
			Declaration: &decl,
			Intents:     []string{"Some intent"},
		},
	}

	originalDesc := defs[0].Declaration.Description
	agent.BuildToolsForModel(defs)

	// Original should be unchanged.
	if defs[0].Declaration.Description != originalDesc {
		t.Errorf("original description mutated: %q", defs[0].Declaration.Description)
	}
}

func TestExecuteToolCallsSingle(t *testing.T) {
	decl := genaiDecl("echo", "Echo back the input")
	registry := agent.NewToolRegistry([]*agent.ToolDef{
		{
			Declaration: &decl,
			Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
				return args, nil
			},
		},
	})

	calls := []agent.ToolCallRequest{
		{CallID: "call-1", Name: "echo", Args: json.RawMessage(`{"text":"hello"}`)},
	}

	results := agent.ExecuteToolCalls(context.Background(), calls, registry)
	if len(results) != 1 {
		t.Fatalf("results count = %d, want 1", len(results))
	}
	if results[0].Err != nil {
		t.Errorf("unexpected error: %v", results[0].Err)
	}
	if string(results[0].ResponseJSON) != `{"text":"hello"}` {
		t.Errorf("response = %s", results[0].ResponseJSON)
	}
}

func TestExecuteToolCallsParallel(t *testing.T) {
	decl1 := genaiDecl("tool_a", "Tool A")
	decl2 := genaiDecl("tool_b", "Tool B")
	registry := agent.NewToolRegistry([]*agent.ToolDef{
		{
			Declaration: &decl1,
			Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
				return json.RawMessage(`{"result":"a"}`), nil
			},
		},
		{
			Declaration: &decl2,
			Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
				return json.RawMessage(`{"result":"b"}`), nil
			},
		},
	})

	calls := []agent.ToolCallRequest{
		{CallID: "c1", Name: "tool_a", Args: json.RawMessage(`{}`)},
		{CallID: "c2", Name: "tool_b", Args: json.RawMessage(`{}`)},
	}

	results := agent.ExecuteToolCalls(context.Background(), calls, registry)
	if len(results) != 2 {
		t.Fatalf("results count = %d, want 2", len(results))
	}

	// Results should be in the same order as calls.
	if results[0].CallID != "c1" || results[1].CallID != "c2" {
		t.Error("result order does not match call order")
	}
	if results[0].Err != nil || results[1].Err != nil {
		t.Errorf("unexpected errors: %v, %v", results[0].Err, results[1].Err)
	}
}

func TestExecuteToolCallsUnknownTool(t *testing.T) {
	registry := agent.NewToolRegistry(nil)

	calls := []agent.ToolCallRequest{
		{CallID: "c1", Name: "nonexistent", Args: json.RawMessage(`{}`)},
	}

	results := agent.ExecuteToolCalls(context.Background(), calls, registry)
	if results[0].Err == nil {
		t.Error("expected error for unknown tool")
	}
	if !strings.Contains(string(results[0].ResponseJSON), "unknown tool") {
		t.Errorf("response should mention unknown tool: %s", results[0].ResponseJSON)
	}
}

func TestExecuteToolCallsHandlerError(t *testing.T) {
	decl := genaiDecl("failing", "Always fails")
	registry := agent.NewToolRegistry([]*agent.ToolDef{
		{
			Declaration: &decl,
			Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
				return nil, context.DeadlineExceeded
			},
		},
	})

	calls := []agent.ToolCallRequest{
		{CallID: "c1", Name: "failing", Args: json.RawMessage(`{}`)},
	}

	results := agent.ExecuteToolCalls(context.Background(), calls, registry)
	if results[0].Err == nil {
		t.Error("expected error from failing handler")
	}
	if !strings.Contains(string(results[0].ResponseJSON), "context deadline exceeded") {
		t.Errorf("response should contain error: %s", results[0].ResponseJSON)
	}
}

func TestNewToolRegistry(t *testing.T) {
	decl1 := genaiDecl("tool_a", "A")
	decl2 := genaiDecl("tool_b", "B")
	registry := agent.NewToolRegistry([]*agent.ToolDef{
		{Declaration: &decl1, Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) { return nil, nil }},
		{Declaration: &decl2, Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) { return nil, nil }},
	})

	if len(registry) != 2 {
		t.Fatalf("registry size = %d, want 2", len(registry))
	}
	if _, ok := registry["tool_a"]; !ok {
		t.Error("tool_a not found in registry")
	}
	if _, ok := registry["tool_b"]; !ok {
		t.Error("tool_b not found in registry")
	}
}

// ─────────────────────────────────────────────────────────────────
// Event Types Tests
// ─────────────────────────────────────────────────────────────────

func TestTurnEventJSON(t *testing.T) {
	event := agent.TurnEvent{
		Kind: agent.EventDelta,
		Delta: &agent.StreamDelta{
			Text:      "Hello",
			IsThought: false,
		},
	}

	data, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}

	var decoded agent.TurnEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}

	if decoded.Kind != agent.EventDelta {
		t.Errorf("Kind = %q, want %q", decoded.Kind, agent.EventDelta)
	}
	if decoded.Delta.Text != "Hello" {
		t.Errorf("Delta.Text = %q", decoded.Delta.Text)
	}
}

func TestTurnEventKinds(t *testing.T) {
	kinds := []agent.TurnEventKind{
		agent.EventTurnStarted,
		agent.EventDelta,
		agent.EventMessageDone,
		agent.EventToolCallStart,
		agent.EventToolResult,
		agent.EventTurnComplete,
		agent.EventTurnAborted,
		agent.EventError,
	}

	for _, k := range kinds {
		if string(k) == "" {
			t.Error("empty event kind")
		}
	}
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

func genaiDecl(name, description string) genai.FunctionDeclaration {
	return genai.FunctionDeclaration{
		Name:        name,
		Description: description,
	}
}
