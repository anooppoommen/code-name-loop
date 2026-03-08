package evals

import "testing"

func TestInferExpectationsPrefersParallelDiscoveryForBroadPatch(t *testing.T) {
	conv := dbConversation{Title: "Screenshot Support"}
	bundle := turnBundle{
		UserText: "I need the ability to send screen shots to the model, this needs changes to both the backend and the front end and the composer UI.",
	}
	artifacts := []string{"Composer", "loop-desktop/src/components/Composer.tsx", "loop/handlers/conversation_handler.go"}

	got := inferExpectations(conv, bundle, 0, artifacts)
	if !got.PreferParallelDiscovery {
		t.Fatal("expected broad cross-layer task to prefer parallel discovery")
	}
	if len(got.PreferredFirstTools) == 0 || got.PreferredFirstTools[0] != "parallel_tool_use" {
		t.Fatalf("preferred first tools = %#v, want parallel_tool_use first", got.PreferredFirstTools)
	}
}

func TestInferExpectationsDoesNotPreferParallelDiscoveryForSmallScopedTask(t *testing.T) {
	conv := dbConversation{Title: "Lighter Indicator"}
	bundle := turnBundle{
		UserText: "Can you make the colors of the thinking indicator lighter",
	}
	artifacts := []string{"ActivityStatusItem"}

	got := inferExpectations(conv, bundle, 0, artifacts)
	if got.PreferParallelDiscovery {
		t.Fatal("expected small scoped task to avoid parallel discovery preference")
	}
}
