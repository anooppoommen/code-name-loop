package models

import "time"

// ─────────────────────────────────────────────────────────────────
// Thread lifecycle types
// ─────────────────────────────────────────────────────────────────

// ThreadMode controls whether a spawned sub-agent runs synchronously
// (the parent tool call blocks until the child completes) or asynchronously
// (the parent receives a thread_id immediately and uses await_thread later).
type ThreadMode string

const (
	ThreadModeBlocking ThreadMode = "blocking"
	ThreadModeAsync    ThreadMode = "async"
)

// ThreadStatus is the lifecycle state of a spawned sub-agent thread.
type ThreadStatus string

const (
	ThreadStatusRunning   ThreadStatus = "running"
	ThreadStatusCompleted ThreadStatus = "completed"
	ThreadStatusFailed    ThreadStatus = "failed"
)

// ContextStrategy controls how much parent history is fed to the sub-agent.
type ContextStrategy string

const (
	// ContextStrategyFullChain walks up the ParentConversationID chain and
	// prepends the full ancestor prefix up to each anchor point (default).
	ContextStrategyFullChain ContextStrategy = "full_chain"

	// ContextStrategySummary skips the parent walk entirely; the sub-agent sees
	// only its own conversation messages starting from the task message.
	ContextStrategySummary ContextStrategy = "summary"
)

// ─────────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────────

// Conversation is the primary unit of interaction — an ordered transcript of
// messages between a user, the agent, and tool invocations.
//
// Threading model:
//   - Root conversations have ParentConversationID == "" and AnchorMessageID == "".
//   - Thread conversations set ParentConversationID to the parent conversation
//     and AnchorMessageID to the message in that parent where the thread forks.
//
// This design enables deterministic parent-history composition:
//
//	parent prefix (start → anchor) ++ thread messages (start → leaf)
//
// and supports nested threads by walking up the ParentConversationID chain.
type Conversation struct {
	ID          ConversationID
	WorkspaceID WorkspaceID

	Title string

	WorktreePath string // If set, overrides the workspace RootPath for agent execution.

	// SystemPromptID/SystemPromptName track the latest prompt variant used
	// for turns in this conversation. Per-turn provenance also lives on
	// message metadata so conversations can span prompt upgrades safely.
	SystemPromptID   string
	SystemPromptName string

	// Threading anchors (empty for root conversations).
	ParentConversationID ConversationID
	AnchorMessageID      MessageID

	// Convenience pointers (cacheable / derivable) for fast UI and history queries.
	RootMessageID MessageID
	HeadMessageID MessageID

	// ── Sub-agent thread fields (empty for root conversations) ──────────────
	//
	// ThreadMode and ThreadStatus describe how this thread was spawned and
	// its current lifecycle state.
	ThreadMode   ThreadMode
	ThreadStatus ThreadStatus

	// ContextStrategy controls which parent history the sub-agent receives.
	ContextStrategy ContextStrategy

	// ResultMessage is the sub-agent's final synthesised text answer,
	// written atomically when status transitions to completed or failed.
	// The parent reads this from the spawn_thread tool response JSON.
	ResultMessage string

	CreatedAt time.Time
	UpdatedAt time.Time
}

// IsThread returns true if this conversation is a thread anchored to a parent.
func (c *Conversation) IsThread() bool {
	return c.ParentConversationID != ""
}
