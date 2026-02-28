// Package store defines the repository interfaces for persisting
// and querying the agent's core domain objects.
package store

import (
	"context"

	"loop/models"
)

// Store is the top-level aggregate that provides access to
// each domain-specific sub-store. Implementations are expected
// to share an underlying connection or transaction scope.
type Store interface {
	Workspaces() WorkspaceStore
	Conversations() ConversationStore
	Messages() MessageStore
	UIEvents() UIEventStore

	// Close releases all resources held by the store.
	Close() error
}

// WorkspaceStore manages the lifecycle and lookup of workspaces.
type WorkspaceStore interface {
	Create(ctx context.Context, ws *models.Workspace) error
	Get(ctx context.Context, id models.WorkspaceID) (*models.Workspace, error)
	GetByRootPath(ctx context.Context, canonicalPath string) (*models.Workspace, error)
	Update(ctx context.Context, ws *models.Workspace) error
	Delete(ctx context.Context, id models.WorkspaceID) error
	List(ctx context.Context) ([]*models.Workspace, error)
}

// ConversationStore manages conversations (both root and threads).
type ConversationStore interface {
	Create(ctx context.Context, conv *models.Conversation) error
	Get(ctx context.Context, id models.ConversationID) (*models.Conversation, error)
	ListByWorkspace(ctx context.Context, wsID models.WorkspaceID) ([]*models.Conversation, error)
	ListThreads(ctx context.Context, parentConvID models.ConversationID) ([]*models.Conversation, error)
	Update(ctx context.Context, conv *models.Conversation) error
	Delete(ctx context.Context, id models.ConversationID) error
}

// MessageStore manages the append-only message transcript within conversations.
type MessageStore interface {
	// Append adds a message and auto-assigns the next Seq number.
	Append(ctx context.Context, msg *models.Message) error

	Get(ctx context.Context, id models.MessageID) (*models.Message, error)

	// GetRange returns messages in [fromSeq, toSeq] within a single conversation.
	GetRange(ctx context.Context, convID models.ConversationID, fromSeq, toSeq int64) ([]*models.Message, error)

	// GetParentHistory walks up the ParentConversationID chain and returns
	// the concatenated message prefix from root conversation start through to
	// the specified sequence in the leaf conversation.
	// Result ordering: root prefix → ... → parent prefix(up to anchor) → leaf conversation messages(up to upToSeq).
	GetParentHistory(ctx context.Context, convID models.ConversationID, upToSeq int64) ([]*models.Message, error)

	// Update modifies an existing message (e.g., state transitions, appending parts during streaming).
	Update(ctx context.Context, msg *models.Message) error

	// Delete removes a message by ID.
	Delete(ctx context.Context, id models.MessageID) error
}

// UIEventStore persists UI-only timeline events that are NOT sent to the model.
// Events are ordered by their per-conversation monotonic Seq, guaranteeing
// deterministic interleaving with models.Message when building a timeline.
type UIEventStore interface {
	// Append persists a UIEvent, auto-assigning the next Seq for the conversation.
	Append(ctx context.Context, evt *models.UIEvent) error

	// GetByConversation returns all UIEvents for a conversation ordered by Seq ASC.
	GetByConversation(ctx context.Context, convID models.ConversationID) ([]*models.UIEvent, error)

	// GetByMessage returns all UIEvents associated with a specific message.
	GetByMessage(ctx context.Context, msgID models.MessageID) ([]*models.UIEvent, error)
}
