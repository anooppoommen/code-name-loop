package evals

import "testing"

func TestDeterministicFindingsFlagsMissedParallelDiscovery(t *testing.T) {
	testCase := Case{
		Expectations: Expectations{
			ShouldPatch:             true,
			PreferStructuredTools:   true,
			PreferParallelDiscovery: true,
		},
	}

	findings := deterministicFindings(testCase, []ToolCallSnapshot{
		{Name: "grep_files"},
	})

	if !contains(findings, "missed_parallel_discovery") {
		t.Fatalf("findings = %#v, want missed_parallel_discovery", findings)
	}
}

func TestDeterministicFindingsAcceptsParallelToolUse(t *testing.T) {
	testCase := Case{
		Expectations: Expectations{
			ShouldPatch:             true,
			PreferStructuredTools:   true,
			PreferParallelDiscovery: true,
		},
	}

	findings := deterministicFindings(testCase, []ToolCallSnapshot{
		{
			Name: "parallel_tool_use",
			Args: map[string]any{
				"tool_uses": []any{
					map[string]any{"name": "read_file", "arguments": map[string]any{"file_path": "a.go"}},
					map[string]any{"name": "grep_files", "arguments": map[string]any{"pattern": "foo", "path": "."}},
				},
			},
		},
	})

	if contains(findings, "missed_parallel_discovery") {
		t.Fatalf("findings = %#v, did not expect missed_parallel_discovery", findings)
	}
}
