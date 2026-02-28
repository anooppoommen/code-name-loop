// Package models defines the core domain types for the agent system.
// These types are the canonical representation of workspaces, conversations,
// messages, and their components. They are designed to faithfully represent
// Gemini API protocol objects (Content/Part) while remaining natural for
// persistence and UI rendering.
package models

// ----- ID types -----

type WorkspaceID string
type ConversationID string
type MessageID string
type AttachmentID string

// ----- Path access -----

type PathAccessMode string

const (
	PathAccessRead  PathAccessMode = "read"
	PathAccessWrite PathAccessMode = "write"
)

// ----- Message lifecycle -----

type MessageState string

const (
	MessageStatePending   MessageState = "pending"
	MessageStateRunning   MessageState = "running"
	MessageStateCompleted MessageState = "completed"
	MessageStateFailed    MessageState = "failed"
	MessageStateCanceled  MessageState = "canceled"
)

// ----- Sender / role -----

type Sender string

const (
	SentByUser  Sender = "user"
	SentByAgent Sender = "agent"
	SentByTool  Sender = "tool"
)

// ----- Part kind -----

type PartKind string

const (
	PartText             PartKind = "text"
	PartFunctionCall     PartKind = "function_call"
	PartFunctionResponse PartKind = "function_response"
	PartFileRef          PartKind = "file_ref"
	PartInlineBlob       PartKind = "inline_blob"
	PartExecutableCode   PartKind = "executable_code"
	PartCodeExecResult   PartKind = "code_execution_result"
	PartThought          PartKind = "thought"
)

// ----- Attachment kind -----

type AttachmentType string

const (
	AttachmentTypeFile      AttachmentType = "file"
	AttachmentTypeToolTrace AttachmentType = "tool_trace"
)
