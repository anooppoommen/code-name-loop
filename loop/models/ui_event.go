package models

import "time"

// UIEventKind identifies the type of a UIEvent.
// UIEvents are NOT sent to the model — they exist purely for the UI to render
// a rich, sequential activity timeline.
type UIEventKind string

const (
	// UIEventKindStatus is a generic progress update ("turn started", "model call started").
	UIEventKindStatus UIEventKind = "status"
	// UIEventKindThought is an extracted summary of a model thought delta ("thinking: ...").
	UIEventKindThought UIEventKind = "thought"
	// UIEventKindToolStart is emitted when a tool execution begins.
	UIEventKindToolStart UIEventKind = "tool_start"
	// UIEventKindToolResult is emitted when a tool execution completes.
	UIEventKindToolResult UIEventKind = "tool_result"
	// UIEventKindThreadStatus is emitted for sub-agent lifecycle events (spawned, started, completed, failed).
	UIEventKindThreadStatus UIEventKind = "thread_status"
	// UIEventKindStateTransition is emitted when the turn FSM transitions between states.
	UIEventKindStateTransition UIEventKind = "state_transition"
	// UIEventKindModelWaitStarted is emitted when a model attempt begins.
	UIEventKindModelWaitStarted UIEventKind = "model_wait_started"
	// UIEventKindModelWaitFinished is emitted when a model attempt ends with timing metadata.
	UIEventKindModelWaitFinished UIEventKind = "model_wait_finished"
	// UIEventKindApprovalRequest is emitted when command approval is required.
	UIEventKindApprovalRequest UIEventKind = "approval_request"
	// UIEventKindError is emitted when a turn encounters an unrecoverable error.
	UIEventKindError UIEventKind = "error"
	// UIEventKindAbort is emitted when a turn is intentionally cancelled.
	UIEventKindAbort UIEventKind = "abort"
)

// UIEvent is a concrete, persisted timeline entry for the UI.
// Each event is associated with both a ConversationID and the specific
// MessageID of the agent message being generated at the time.
//
// Association model:
//   - ConversationID: which conversation (root or child thread) the event belongs to.
//   - MessageID: the agent Message that was being assembled when this event fired.
//     This lets the UI attach the event to the correct message in the timeline.
//
// Monotonic ordering is guaranteed by the Seq field (auto-assigned at Append time,
// scoped per conversation). This ensures Messages and UIEvents can be merged into
// a single chronological timeline without relying on wall-clock precision.
type UIEvent struct {
	ID             string         `json:"id"`
	ConversationID ConversationID `json:"conversation_id"`

	// MessageID associates this event with the agent Message being generated.
	// Empty for session-level events (e.g. "turn started") that precede any message.
	MessageID MessageID `json:"message_id,omitempty"`

	// Monotonic per-conversation order. Assigned at Append time, starting at 1.
	// Combined with messages.seq this guarantees a deterministic interleaved timeline.
	Seq int64 `json:"seq"`

	// Monotonic per-conversation sequence shared with messages.
	// This is the canonical ordering field for timeline replay.
	TimelineSeq int64 `json:"timeline_seq,omitempty"`

	Kind UIEventKind `json:"kind"`

	// Text is the human-readable description of the event shown in the UI.
	Text string `json:"text"`

	// Metadata holds structured context specific to the event kind, e.g.:
	//   tool_start:    {"tool_name": "grep_files", "call_id": "abc123", "iteration": 2}
	//   tool_result:   {"tool_name": "grep_files", "call_id": "abc123", "success": true}
	//   thread_status: {"thread_id": "xyz", "status": "completed"}
	Metadata map[string]any `json:"metadata,omitempty"`

	CreatedAt time.Time `json:"created_at"`
}
