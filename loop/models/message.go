package models

import (
	"encoding/json"
	"time"
)

// Message is a single node in a conversation's ordered transcript.
// Its Parts field is the canonical, authoritative representation of what must
// be sent back to Gemini for continued tool calling and retries.
type Message struct {
	ID             MessageID
	ConversationID ConversationID

	// Monotonic per-conversation ordering for range queries (A..B)
	// and deterministic history replay. Assigned at append time.
	Seq int64

	// Monotonic per-conversation sequence shared across message and UIEvent rows.
	// This is the canonical ordering field for deterministic timeline replay.
	TimelineSeq int64 `json:"timeline_seq,omitempty"`

	// ReplyToMessageID expresses the logical parent in this conversation's
	// message chain. For linear threads this equals the previous message;
	// retries/branches share the same ReplyToMessageID.
	ReplyToMessageID MessageID

	State  MessageState
	SentBy Sender

	// Ordered, typed parts — the canonical transcript data.
	// This is the ONLY authoritative source for Gemini protocol reconstruction.
	Parts []MessagePart

	// Additional metadata; MUST NOT be relied upon to reconstruct
	// Gemini protocol objects.
	Metadata map[string]any

	// Attachments store heavier payloads; parts reference them by ID.
	Attachments []Attachment

	CreatedAt time.Time
	UpdatedAt time.Time
}

// ---------- Message Parts ----------

// MessagePart is a single typed element within a message's ordered part list.
// It uses a one-of payload pattern: exactly one of the pointer fields is non-nil,
// matching the Kind discriminator.
type MessagePart struct {
	Kind PartKind

	// Provider-specific but critical field for Gemini 3+ tool calling.
	// Stored as raw bytes and MUST round-trip exactly as received.
	// Must never be merged across signature boundaries.
	ThoughtSignature []byte `json:"thought_signature,omitempty"`

	// Gemini-style part metadata for multiplexing, provenance, etc.
	PartMetadata map[string]any `json:"part_metadata,omitempty"`

	// One-of payload (exactly one non-nil, matching Kind):
	Text             *TextPart                `json:"text,omitempty"`
	FunctionCall     *FunctionCallPart        `json:"function_call,omitempty"`
	FunctionResponse *FunctionResponsePart    `json:"function_response,omitempty"`
	FileRef          *FileRefPart             `json:"file_ref,omitempty"`
	InlineBlob       *InlineBlobPart          `json:"inline_blob,omitempty"`
	ExecutableCode   *ExecutableCodePart      `json:"executable_code,omitempty"`
	CodeExecResult   *CodeExecutionResultPart `json:"code_exec_result,omitempty"`
	Thought          *ThoughtPart             `json:"thought,omitempty"`
}

// ---------- Part payloads ----------

// TextPart holds plain text content.
type TextPart struct {
	Text string `json:"text"`
}

// ThoughtPart holds model "thought" content when include_thoughts is enabled.
// Kept as a separate part to avoid merging issues with signatures.
type ThoughtPart struct {
	Text string `json:"text"`
}

// FunctionCallPart represents a model-issued tool invocation.
type FunctionCallPart struct {
	// CallID is a unique identifier for correlating calls with responses.
	CallID string `json:"call_id"`

	// Name of the function/tool to invoke.
	Name string `json:"name"`

	// JSON args as a raw object; stored raw to preserve exact structure.
	ArgsJSON json.RawMessage `json:"args_json"`

	// Streaming support: partial args deltas accumulated during SSE.
	PartialArgs  []PartialArgDelta `json:"partial_args,omitempty"`
	WillContinue bool              `json:"will_continue,omitempty"`
}

// PartialArgDelta represents a streaming partial argument update.
type PartialArgDelta struct {
	JSONPath     string          `json:"json_path"`
	DeltaJSON    json.RawMessage `json:"delta_json"`
	WillContinue bool            `json:"will_continue,omitempty"`
}

// FunctionResponsePart represents the result of a tool invocation.
type FunctionResponsePart struct {
	// CallID correlates this response to its originating FunctionCallPart.
	CallID string `json:"call_id"`

	// Name of the function/tool that was invoked.
	Name string `json:"name"`

	// JSON response object; stored raw.
	ResponseJSON json.RawMessage `json:"response_json"`

	// Optional references to multimodal blobs/files included in the response.
	RelatedAttachmentIDs []AttachmentID `json:"related_attachment_ids,omitempty"`
}

// FileRefPart references an externally hosted file (e.g., Gemini fileData).
type FileRefPart struct {
	URI         string `json:"uri"`
	MIMEType    string `json:"mime_type"`
	DisplayName string `json:"display_name,omitempty"`
}

// InlineBlobPart references an attachment containing inline binary data.
type InlineBlobPart struct {
	AttachmentID AttachmentID `json:"attachment_id,omitempty"`
	MIMEType     string       `json:"mime_type"`
	Data         string       `json:"data,omitempty"` // Base64 encoded data
	DisplayName  string       `json:"display_name,omitempty"`
}

// ExecutableCodePart holds code to be executed in a sandbox.
type ExecutableCodePart struct {
	Language string `json:"language"`
	Code     string `json:"code"`
}

// CodeExecutionResultPart holds the outcome of code execution.
type CodeExecutionResultPart struct {
	Outcome string `json:"outcome"`
	Output  string `json:"output"`
}

// ---------- Attachments ----------

// Attachment stores heavier payloads associated with a message.
// Parts reference attachments by ID to preserve ordering semantics.
type Attachment struct {
	ID      AttachmentID   `json:"id"`
	Type    AttachmentType `json:"type"`
	Content any            `json:"content"`
}
