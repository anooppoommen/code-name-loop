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
	// EventStatus is emitted for agent progress updates between deltas/tool events.
	EventStatus TurnEventKind = "status"
	// EventRetry is emitted for transient model failures when the server is
	// waiting to retry a model call.
	EventRetry TurnEventKind = "retry"
	// EventApprovalRequest is emitted when a command tool asks for user approval.
	EventApprovalRequest TurnEventKind = "approval_request"
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
	// Status is populated for EventStatus events.
	Status *StatusEvent `json:"status,omitempty"`
	// Retry is populated for EventRetry events.
	Retry *RetryEvent `json:"retry,omitempty"`
	// ApprovalRequest is populated for EventApprovalRequest events.
	ApprovalRequest *ApprovalRequestEvent `json:"approval_request,omitempty"`
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
	// Args is a summarized argument payload for UI display parity between live SSE and persisted timeline.
	Args string `json:"args,omitempty"`
}

// ToolResultEvent represents the result of executing a tool call.
type ToolResultEvent struct {
	CallID  string `json:"call_id"`
	Name    string `json:"name"`
	Success bool   `json:"success"`
	Result  string `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
}

// StatusEvent represents a lightweight progress update during long turns.
type StatusEvent struct {
	Text      string `json:"text"`
	Iteration int    `json:"iteration,omitempty"`
}

// RetryEvent represents retry/backoff state for transient model failures.
type RetryEvent struct {
	// Message is a human-readable status line suitable for direct UI display.
	Message string `json:"message"`
	// Attempt is the 1-based retry attempt number.
	Attempt int `json:"attempt"`
	// MaxAttempts is the maximum number of retries allowed.
	MaxAttempts int `json:"max_attempts"`
	// SecondsRemaining is the countdown value until the next retry attempt.
	SecondsRemaining int `json:"seconds_remaining"`
	// DelaySeconds is the configured retry backoff duration in seconds.
	DelaySeconds int `json:"delay_seconds"`
	// Iteration is the current agent loop iteration.
	Iteration int `json:"iteration,omitempty"`
}

// ApprovalRequestEvent represents a pending command approval request.
type ApprovalRequestEvent struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id,omitempty"`
	ToolName       string `json:"tool_name"`
	Command        string `json:"command"`
	Workdir        string `json:"workdir,omitempty"`
}
