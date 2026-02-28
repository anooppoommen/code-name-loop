package models_test

import (
	"encoding/json"
	"testing"

	"loop/models"
)

func TestConversationIsThread(t *testing.T) {
	root := &models.Conversation{ID: "root", WorkspaceID: "ws"}
	if root.IsThread() {
		t.Error("root conversation should not be a thread")
	}

	thread := &models.Conversation{
		ID: "thread", WorkspaceID: "ws",
		ParentConversationID: "root",
		AnchorMessageID:      "msg-1",
	}
	if !thread.IsThread() {
		t.Error("thread should be a thread")
	}
}

func TestMessagePartKindDiscrimination(t *testing.T) {
	parts := []models.MessagePart{
		{Kind: models.PartText, Text: &models.TextPart{Text: "hello"}},
		{Kind: models.PartThought, Thought: &models.ThoughtPart{Text: "hmm"}},
		{Kind: models.PartFunctionCall, FunctionCall: &models.FunctionCallPart{
			CallID: "c1", Name: "tool", ArgsJSON: json.RawMessage(`{}`),
		}},
		{Kind: models.PartFunctionResponse, FunctionResponse: &models.FunctionResponsePart{
			CallID: "c1", Name: "tool", ResponseJSON: json.RawMessage(`{"ok":true}`),
		}},
		{Kind: models.PartFileRef, FileRef: &models.FileRefPart{
			URI: "gs://bucket/file", MIMEType: "text/plain",
		}},
		{Kind: models.PartExecutableCode, ExecutableCode: &models.ExecutableCodePart{
			Language: "python", Code: "print('hi')",
		}},
		{Kind: models.PartCodeExecResult, CodeExecResult: &models.CodeExecutionResultPart{
			Outcome: "OUTCOME_OK", Output: "hi",
		}},
	}

	for _, p := range parts {
		// Verify JSON round-trip preserves Kind and data.
		data, err := json.Marshal(p)
		if err != nil {
			t.Fatalf("marshal %s: %v", p.Kind, err)
		}

		var decoded models.MessagePart
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("unmarshal %s: %v", p.Kind, err)
		}

		if decoded.Kind != p.Kind {
			t.Errorf("Kind mismatch: got %q, want %q", decoded.Kind, p.Kind)
		}
	}
}

func TestMessagePartThoughtSignaturePreservedInJSON(t *testing.T) {
	original := models.MessagePart{
		Kind: models.PartFunctionCall,
		FunctionCall: &models.FunctionCallPart{
			CallID: "c1", Name: "read_file",
			ArgsJSON: json.RawMessage(`{"path":"main.go"}`),
		},
		ThoughtSignature: []byte{0xDE, 0xAD, 0xBE, 0xEF},
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}

	var decoded models.MessagePart
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}

	if len(decoded.ThoughtSignature) != 4 {
		t.Fatalf("ThoughtSignature length = %d, want 4", len(decoded.ThoughtSignature))
	}
	if decoded.ThoughtSignature[0] != 0xDE || decoded.ThoughtSignature[3] != 0xEF {
		t.Errorf("ThoughtSignature = %x, want DEADBEEF", decoded.ThoughtSignature)
	}
}

func TestPathAccessModeValues(t *testing.T) {
	if models.PathAccessRead != "read" {
		t.Errorf("PathAccessRead = %q", models.PathAccessRead)
	}
	if models.PathAccessWrite != "write" {
		t.Errorf("PathAccessWrite = %q", models.PathAccessWrite)
	}
}

func TestMessageStateValues(t *testing.T) {
	states := []models.MessageState{
		models.MessageStatePending,
		models.MessageStateRunning,
		models.MessageStateCompleted,
		models.MessageStateFailed,
		models.MessageStateCanceled,
	}
	expected := []string{"pending", "running", "completed", "failed", "canceled"}
	for i, s := range states {
		if string(s) != expected[i] {
			t.Errorf("state %d = %q, want %q", i, s, expected[i])
		}
	}
}

func TestSenderValues(t *testing.T) {
	if string(models.SentByUser) != "user" {
		t.Errorf("SentByUser = %q", models.SentByUser)
	}
	if string(models.SentByAgent) != "agent" {
		t.Errorf("SentByAgent = %q", models.SentByAgent)
	}
	if string(models.SentByTool) != "tool" {
		t.Errorf("SentByTool = %q", models.SentByTool)
	}
}
