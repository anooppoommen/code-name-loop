package tools

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"loop/agent"

	"google.golang.org/genai"
)

func TestParallelToolUseRunsCallsConcurrently(t *testing.T) {
	declA := &genai.FunctionDeclaration{Name: "tool_a"}
	declB := &genai.FunctionDeclaration{Name: "tool_b"}

	registry := agent.NewToolRegistry([]*agent.ToolDef{
		{
			Declaration: declA,
			Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
				time.Sleep(120 * time.Millisecond)
				return json.RawMessage(`{"ok":"a"}`), nil
			},
		},
		{
			Declaration: declB,
			Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
				time.Sleep(120 * time.Millisecond)
				return json.RawMessage(`{"ok":"b"}`), nil
			},
		},
	})

	args := json.RawMessage(`{"tool_uses":[{"name":"tool_a","arguments":{}},{"name":"tool_b","arguments":{}}]}`)
	start := time.Now()
	out, err := handleParallelToolUse(context.Background(), args, registry)
	if err != nil {
		t.Fatalf("handleParallelToolUse failed: %v", err)
	}
	elapsed := time.Since(start)

	if elapsed >= 220*time.Millisecond {
		t.Fatalf("expected parallel execution under 220ms, took %v", elapsed)
	}

	var resp struct {
		Results []parallelToolUseResult `json:"results"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(resp.Results) != 2 {
		t.Fatalf("results length = %d, want 2", len(resp.Results))
	}
	if resp.Results[0].Name != "tool_a" || resp.Results[1].Name != "tool_b" {
		t.Fatalf("result order mismatch: %#v", resp.Results)
	}
	if !resp.Results[0].Success || !resp.Results[1].Success {
		t.Fatalf("expected both calls to succeed: %#v", resp.Results)
	}
}

func TestParallelToolUseBlocksDisallowedTools(t *testing.T) {
	decl := &genai.FunctionDeclaration{Name: "apply_patch"}
	registry := agent.NewToolRegistry([]*agent.ToolDef{{
		Declaration: decl,
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return json.RawMessage(`{"ok":true}`), nil
		},
	}})

	args := json.RawMessage(`{"tool_uses":[{"name":"apply_patch","arguments":{}},{"name":"apply_patch","arguments":{}}]}`)
	out, err := handleParallelToolUse(context.Background(), args, registry)
	if err != nil {
		t.Fatalf("handleParallelToolUse failed: %v", err)
	}

	var resp struct {
		Results []parallelToolUseResult `json:"results"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(resp.Results) != 2 {
		t.Fatalf("results length = %d, want 2", len(resp.Results))
	}
	if resp.Results[0].Success {
		t.Fatal("expected first blocked tool call to fail")
	}
	if resp.Results[0].Error == "" {
		t.Fatal("expected error message for first blocked tool")
	}
	if resp.Results[1].Success {
		t.Fatal("expected second blocked tool call to fail")
	}
	if resp.Results[1].Error == "" {
		t.Fatal("expected error message for second blocked tool")
	}
}

func TestParallelToolUseRejectsEmptyCalls(t *testing.T) {
	registry := agent.NewToolRegistry(nil)
	args := json.RawMessage(`{"tool_uses":[]}`)

	_, err := handleParallelToolUse(context.Background(), args, registry)
	if err == nil {
		t.Fatal("expected validation error for empty tool_uses")
	}
}

func TestParallelToolUseRejectsSingleCall(t *testing.T) {
	decl := &genai.FunctionDeclaration{Name: "echo"}
	registry := agent.NewToolRegistry([]*agent.ToolDef{{
		Declaration: decl,
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return args, nil
		},
	}})

	args := json.RawMessage(`{"tool_uses":[{"name":"echo","arguments":{"text":"hello"}}]}`)
	_, err := handleParallelToolUse(context.Background(), args, registry)
	if err == nil {
		t.Fatal("expected validation error for single tool_use")
	}
}

func TestParallelToolUseAcceptsRecipientNameAndParameters(t *testing.T) {
	decl := &genai.FunctionDeclaration{Name: "echo"}
	registry := agent.NewToolRegistry([]*agent.ToolDef{{
		Declaration: decl,
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return args, nil
		},
	}})

	args := json.RawMessage(`{"tool_uses":[{"recipient_name":"functions.echo","parameters":{"text":"hello"}},{"name":"echo","arguments":{"text":"world"}}]}`)
	out, err := handleParallelToolUse(context.Background(), args, registry)
	if err != nil {
		t.Fatalf("handleParallelToolUse failed: %v", err)
	}

	var resp struct {
		Results []parallelToolUseResult `json:"results"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(resp.Results) != 2 {
		t.Fatalf("expected two successful results: %#v", resp.Results)
	}
	if string(resp.Results[0].Response) != `{"text":"hello"}` {
		t.Fatalf("unexpected response payload: %s", string(resp.Results[0].Response))
	}
	if string(resp.Results[1].Response) != `{"text":"world"}` {
		t.Fatalf("unexpected response payload: %s", string(resp.Results[1].Response))
	}
}
