package agent_test

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"loop/agent"
	"loop/models"

	"google.golang.org/genai"
)

// TestMessagesToContentsRoundTrip verifies that converting domain messages to
// genai.Content and back preserves all part data, ordering, and thought signatures.
func TestMessagesToContentsRoundTrip(t *testing.T) {
	original := []*models.Message{
		{
			SentBy: models.SentByUser,
			Parts: []models.MessagePart{
				{
					Kind: models.PartText,
					Text: &models.TextPart{Text: "Hello, please help me with my code."},
				},
			},
		},
		{
			SentBy: models.SentByAgent,
			Parts: []models.MessagePart{
				{
					Kind:             models.PartThought,
					Thought:          &models.ThoughtPart{Text: "Thinking about the user's request..."},
					ThoughtSignature: []byte{0x01, 0x02, 0x03, 0x04},
				},
				{
					Kind: models.PartText,
					Text: &models.TextPart{Text: "I'll read the file first."},
				},
				{
					Kind: models.PartFunctionCall,
					FunctionCall: &models.FunctionCallPart{
						CallID:   "call-1",
						Name:     "read_file",
						ArgsJSON: json.RawMessage(`{"path":"main.go"}`),
					},
					ThoughtSignature: []byte{0x05, 0x06},
				},
			},
		},
		{
			SentBy: models.SentByTool,
			Parts: []models.MessagePart{
				{
					Kind: models.PartFunctionResponse,
					FunctionResponse: &models.FunctionResponsePart{
						CallID:       "call-1",
						Name:         "read_file",
						ResponseJSON: json.RawMessage(`{"content":"package main\n"}`),
					},
				},
			},
		},
	}

	// Convert to genai Contents.
	contents := agent.MessagesToContents(original)

	if len(contents) != 3 {
		t.Fatalf("contents count = %d, want 3", len(contents))
	}

	// Verify roles.
	if contents[0].Role != "user" {
		t.Errorf("contents[0].Role = %q, want %q", contents[0].Role, "user")
	}
	if contents[1].Role != "model" {
		t.Errorf("contents[1].Role = %q, want %q", contents[1].Role, "model")
	}
	if contents[2].Role != "user" {
		t.Errorf("contents[2].Role = %q (tool responses use 'user' role)", contents[2].Role)
	}

	// Verify part count in model response.
	if len(contents[1].Parts) != 3 {
		t.Fatalf("contents[1] parts = %d, want 3", len(contents[1].Parts))
	}

	// Verify thought signature preserved on genai parts.
	if len(contents[1].Parts[0].ThoughtSignature) != 4 {
		t.Errorf("thought signature length = %d, want 4", len(contents[1].Parts[0].ThoughtSignature))
	}
	if len(contents[1].Parts[2].ThoughtSignature) != 2 {
		t.Errorf("function call thought signature length = %d, want 2", len(contents[1].Parts[2].ThoughtSignature))
	}

	// Convert back from genai Contents to domain messages.
	for _, c := range contents {
		msg := agent.ContentToMessage(c)
		if msg == nil {
			t.Fatal("ContentToMessage returned nil")
		}
	}

	// Round-trip the model response specifically.
	roundTripped := agent.ContentToMessage(contents[1])
	if len(roundTripped.Parts) != 3 {
		t.Fatalf("roundTripped parts = %d, want 3", len(roundTripped.Parts))
	}

	// Part 0: thought with signature.
	if roundTripped.Parts[0].Kind != models.PartThought {
		t.Errorf("roundTripped[0].Kind = %q, want %q", roundTripped.Parts[0].Kind, models.PartThought)
	}
	if roundTripped.Parts[0].Thought.Text != "Thinking about the user's request..." {
		t.Errorf("roundTripped[0].Thought.Text = %q", roundTripped.Parts[0].Thought.Text)
	}
	if len(roundTripped.Parts[0].ThoughtSignature) != 4 {
		t.Errorf("roundTripped[0].ThoughtSignature = %x", roundTripped.Parts[0].ThoughtSignature)
	}

	// Part 1: text.
	if roundTripped.Parts[1].Kind != models.PartText {
		t.Errorf("roundTripped[1].Kind = %q, want %q", roundTripped.Parts[1].Kind, models.PartText)
	}
	if roundTripped.Parts[1].Text.Text != "I'll read the file first." {
		t.Errorf("roundTripped[1].Text = %q", roundTripped.Parts[1].Text.Text)
	}

	// Part 2: function call with signature.
	if roundTripped.Parts[2].Kind != models.PartFunctionCall {
		t.Errorf("roundTripped[2].Kind = %q, want %q", roundTripped.Parts[2].Kind, models.PartFunctionCall)
	}
	if roundTripped.Parts[2].FunctionCall.Name != "read_file" {
		t.Errorf("roundTripped[2].FunctionCall.Name = %q", roundTripped.Parts[2].FunctionCall.Name)
	}
	// Verify args round-trip.
	var args map[string]string
	if err := json.Unmarshal(roundTripped.Parts[2].FunctionCall.ArgsJSON, &args); err != nil {
		t.Fatalf("unmarshal args: %v", err)
	}
	if args["path"] != "main.go" {
		t.Errorf("args[path] = %q, want %q", args["path"], "main.go")
	}
	if len(roundTripped.Parts[2].ThoughtSignature) != 2 {
		t.Errorf("roundTripped[2].ThoughtSignature = %x", roundTripped.Parts[2].ThoughtSignature)
	}
}

// TestFunctionResponseRoundTrip verifies function response conversion.
func TestFunctionResponseRoundTrip(t *testing.T) {
	original := &models.Message{
		SentBy: models.SentByTool,
		Parts: []models.MessagePart{
			{
				Kind: models.PartFunctionResponse,
				FunctionResponse: &models.FunctionResponsePart{
					CallID:       "call-42",
					Name:         "write_file",
					ResponseJSON: json.RawMessage(`{"success":true,"bytes_written":1234}`),
				},
			},
		},
	}

	contents := agent.MessagesToContents([]*models.Message{original})
	if len(contents) != 1 {
		t.Fatalf("contents = %d, want 1", len(contents))
	}

	c := contents[0]
	if c.Parts[0].FunctionResponse == nil {
		t.Fatal("expected FunctionResponse part")
	}
	if c.Parts[0].FunctionResponse.Name != "write_file" {
		t.Errorf("response name = %q", c.Parts[0].FunctionResponse.Name)
	}

	// Round-trip back.
	msg := agent.ContentToMessage(c)
	if msg.Parts[0].FunctionResponse.Name != "write_file" {
		t.Errorf("roundTripped name = %q", msg.Parts[0].FunctionResponse.Name)
	}

	var resp map[string]any
	json.Unmarshal(msg.Parts[0].FunctionResponse.ResponseJSON, &resp)
	if resp["success"] != true {
		t.Errorf("response success = %v", resp["success"])
	}
}

// TestParallelToolCallOrdering ensures that when multiple function calls
// appear in a single model turn, they are preserved in order.
func TestParallelToolCallOrdering(t *testing.T) {
	msg := &models.Message{
		SentBy: models.SentByAgent,
		Parts: []models.MessagePart{
			{
				Kind: models.PartFunctionCall,
				FunctionCall: &models.FunctionCallPart{
					CallID: "call-a", Name: "tool_a",
					ArgsJSON: json.RawMessage(`{}`),
				},
				ThoughtSignature: []byte{0x01},
			},
			{
				Kind: models.PartFunctionCall,
				FunctionCall: &models.FunctionCallPart{
					CallID: "call-b", Name: "tool_b",
					ArgsJSON: json.RawMessage(`{}`),
				},
			},
		},
	}

	contents := agent.MessagesToContents([]*models.Message{msg})
	if len(contents[0].Parts) != 2 {
		t.Fatalf("parts = %d, want 2", len(contents[0].Parts))
	}

	// Verify ordering preserved.
	if contents[0].Parts[0].FunctionCall.Name != "tool_a" {
		t.Errorf("first call = %q, want tool_a", contents[0].Parts[0].FunctionCall.Name)
	}
	if contents[0].Parts[1].FunctionCall.Name != "tool_b" {
		t.Errorf("second call = %q, want tool_b", contents[0].Parts[1].FunctionCall.Name)
	}

	// Signature only on first call.
	if len(contents[0].Parts[0].ThoughtSignature) != 1 {
		t.Errorf("first call sig = %x", contents[0].Parts[0].ThoughtSignature)
	}
	if len(contents[0].Parts[1].ThoughtSignature) != 0 {
		t.Errorf("second call should have no sig, got %x", contents[0].Parts[1].ThoughtSignature)
	}
}

// TestFileRefPartConversion tests file data part conversion.
func TestFileRefPartConversion(t *testing.T) {
	msg := &models.Message{
		SentBy: models.SentByUser,
		Parts: []models.MessagePart{
			{
				Kind: models.PartFileRef,
				FileRef: &models.FileRefPart{
					URI:         "gs://bucket/file.pdf",
					MIMEType:    "application/pdf",
					DisplayName: "file.pdf",
				},
			},
		},
	}

	contents := agent.MessagesToContents([]*models.Message{msg})
	if contents[0].Parts[0].FileData == nil {
		t.Fatal("expected FileData part")
	}
	if contents[0].Parts[0].FileData.FileURI != "gs://bucket/file.pdf" {
		t.Errorf("FileURI = %q", contents[0].Parts[0].FileData.FileURI)
	}

	// Round-trip.
	rt := agent.ContentToMessage(contents[0])
	if rt.Parts[0].FileRef.URI != "gs://bucket/file.pdf" {
		t.Errorf("roundTripped URI = %q", rt.Parts[0].FileRef.URI)
	}
	if rt.Parts[0].FileRef.MIMEType != "application/pdf" {
		t.Errorf("roundTripped MIMEType = %q", rt.Parts[0].FileRef.MIMEType)
	}
}

// TestSenderRoleMapping verifies correct role mapping.
func TestSenderRoleMapping(t *testing.T) {
	tests := []struct {
		sender   models.Sender
		wantRole string
	}{
		{models.SentByUser, "user"},
		{models.SentByAgent, "model"},
		{models.SentByTool, "user"}, // tool responses use "user" role in Gemini
	}

	for _, tt := range tests {
		msg := &models.Message{
			SentBy: tt.sender,
			Parts:  []models.MessagePart{{Kind: models.PartText, Text: &models.TextPart{Text: "x"}}},
		}
		contents := agent.MessagesToContents([]*models.Message{msg})
		if contents[0].Role != tt.wantRole {
			t.Errorf("sender %q → role %q, want %q", tt.sender, contents[0].Role, tt.wantRole)
		}
	}
}

func TestMessagesToContentsSkipsEmptyTextPart(t *testing.T) {
	msg := &models.Message{
		SentBy: models.SentByAgent,
		Parts: []models.MessagePart{
			{
				Kind: models.PartFunctionCall,
				FunctionCall: &models.FunctionCallPart{
					Name:     "shell",
					ArgsJSON: json.RawMessage(`{"command":"pwd"}`),
				},
			},
			{
				Kind: models.PartText,
				Text: &models.TextPart{Text: ""},
			},
		},
	}

	contents := agent.MessagesToContents([]*models.Message{msg})
	if len(contents) != 1 {
		t.Fatalf("contents count = %d, want 1", len(contents))
	}
	if len(contents[0].Parts) != 1 {
		t.Fatalf("parts count = %d, want 1 (empty text part should be skipped)", len(contents[0].Parts))
	}
	if contents[0].Parts[0].FunctionCall == nil {
		t.Fatalf("expected function call part, got %#v", contents[0].Parts[0])
	}
}

func TestContentToMessageSkipsStructurallyEmptyPart(t *testing.T) {
	content := &genai.Content{
		Role: "model",
		Parts: []*genai.Part{
			{
				FunctionCall: &genai.FunctionCall{Name: "shell", Args: map[string]any{"command": "pwd"}},
			},
			{
				// Simulates malformed/empty part returned by model.
				Text: "",
			},
		},
	}

	msg := agent.ContentToMessage(content)
	if len(msg.Parts) != 1 {
		t.Fatalf("parts count = %d, want 1 (empty part should be skipped)", len(msg.Parts))
	}
	if msg.Parts[0].Kind != models.PartFunctionCall {
		t.Fatalf("kind = %q, want %q", msg.Parts[0].Kind, models.PartFunctionCall)
	}
}

func TestMessagesToModelContents_PrunesHistoryPayloads(t *testing.T) {
	blobData := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	history := []*models.Message{
		{
			SentBy: models.SentByUser,
			Parts: []models.MessagePart{
				{Kind: models.PartText, Text: &models.TextPart{Text: "look at this screenshot"}},
				{
					Kind: models.PartInlineBlob,
					InlineBlob: &models.InlineBlobPart{
						MIMEType: "image/png",
						Data:     blobData,
					},
				},
			},
		},
		{
			SentBy: models.SentByAgent,
			Parts: []models.MessagePart{
				{
					Kind:             models.PartThought,
					Thought:          &models.ThoughtPart{Text: "long internal reasoning"},
					ThoughtSignature: []byte{0x01, 0x02},
				},
				{
					Kind: models.PartFunctionCall,
					FunctionCall: &models.FunctionCallPart{
						CallID:   "call-1",
						Name:     "list_dir",
						ArgsJSON: json.RawMessage(`{"dir_path":"."}`),
					},
				},
			},
		},
		{
			SentBy: models.SentByTool,
			Parts: []models.MessagePart{
				{
					Kind: models.PartFunctionResponse,
					FunctionResponse: &models.FunctionResponsePart{
						CallID:       "call-1",
						Name:         "list_dir",
						ResponseJSON: json.RawMessage(`{"output":"ok"}`),
					},
				},
			},
		},
	}

	contents := agent.MessagesToModelContents(history)
	if len(contents) != 3 {
		t.Fatalf("contents count = %d, want 3", len(contents))
	}

	for _, c := range contents {
		for _, p := range c.Parts {
			if p.InlineData != nil {
				t.Fatalf("historical inline blob should be omitted from model history")
			}
		}
	}

	for _, p := range contents[1].Parts {
		if p.Thought {
			t.Fatalf("thought parts should be omitted from model history payload")
		}
	}
}

func TestMessagesToModelContents_KeepTailInlineBlob(t *testing.T) {
	blobData := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	history := []*models.Message{
		{
			SentBy: models.SentByUser,
			Parts: []models.MessagePart{
				{Kind: models.PartText, Text: &models.TextPart{Text: "latest screenshot"}},
				{
					Kind: models.PartInlineBlob,
					InlineBlob: &models.InlineBlobPart{
						MIMEType: "image/png",
						Data:     blobData,
					},
				},
			},
		},
	}

	contents := agent.MessagesToModelContents(history)
	if len(contents) != 1 {
		t.Fatalf("contents count = %d, want 1", len(contents))
	}

	foundInline := false
	for _, p := range contents[0].Parts {
		if p.InlineData != nil {
			foundInline = true
			if p.InlineData.MIMEType != "image/png" {
				t.Fatalf("inline MIME type = %q, want image/png", p.InlineData.MIMEType)
			}
		}
	}
	if !foundInline {
		t.Fatalf("tail inline blob should be preserved")
	}
}
