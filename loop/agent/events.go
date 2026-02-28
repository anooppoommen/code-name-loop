package agent

// TurnEventKind identifies the type of event emitted during a turn.
type TurnEventKind string

const (
	// EventTurnStarted is emitted at the beginning of a turn, before the model
	// is called.
	EventTurnStarted TurnEventKind = "turn_started"
	// EventDelta is emitted for each streaming chunk of text or thought content.
	EventDelta TurnEventKind = "delta"
	// EventMessageDone is emitted when a complete message has been assembled
	// from the streaming response and persisted.
	EventMessageDone TurnEventKind = "message_done"
	// EventToolCallStart is emitted when the model requests a tool call.
	EventToolCallStart TurnEventKind = "tool_call_start"
	// EventToolResult is emitted when a tool call completes.
	EventToolResult TurnEventKind = "tool_result"
	// EventTurnComplete is emitted when the entire turn is finished
	// (no more tool calls, model has produced a final response).
	EventTurnComplete TurnEventKind = "turn_complete"
	// EventTurnAborted is emitted when a turn is cancelled before completion.
	// Distinguished from EventError: aborted = intentional cancellation,
	// error = unexpected failure.
	EventTurnAborted TurnEventKind = "turn_aborted"
	// EventError is emitted when an unrecoverable error occurs during the turn.
	EventError TurnEventKind = "error"
)

// TurnEvent is a single event emitted during a turn's lifecycle.
// Consumers read these from the channel returned by Turn.Run() or
// Session.HandleUserMessage().
type TurnEvent struct {
	Kind TurnEventKind `json:"kind"`

	// Delta contains partial text content for EventDelta events.
	Delta *StreamDelta `json:"delta,omitempty"`
	// Message is the fully assembled message for EventMessageDone events.
	Message interface{} `json:"message,omitempty"`
	// ToolCall is populated for EventToolCallStart events.
	ToolCall *ToolCallEvent `json:"tool_call,omitempty"`
	// ToolResult is populated for EventToolResult events.
	ToolResult *ToolResultEvent `json:"tool_result,omitempty"`
	// Error is populated for EventError events.
	Error error `json:"-"`
	// ErrorText is the serializable error string for JSON transport.
	ErrorText string `json:"error,omitempty"`
}

// StreamDelta represents a partial content chunk from the streaming response.
type StreamDelta struct {
	// Text is the incremental text content (may be empty if this is a thought delta).
	Text string `json:"text,omitempty"`
	// IsThought indicates this delta is from the model's thinking process.
	IsThought bool `json:"is_thought,omitempty"`
}

// ToolCallEvent represents a function call requested by the model.
type ToolCallEvent struct {
	CallID string `json:"call_id"`
	Name   string `json:"name"`
}

// ToolResultEvent represents the result of executing a tool call.
type ToolResultEvent struct {
	CallID  string `json:"call_id"`
	Name    string `json:"name"`
	Success bool   `json:"success"`
}
