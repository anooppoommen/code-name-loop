package models

import "time"

// Checkpoint stores a restorable snapshot of a workspace state for a conversation.
// Snapshot contents live in Git object storage; this record stores the metadata needed
// to locate and safely restore that snapshot.
type Checkpoint struct {
	ID             string         `json:"id"`
	ConversationID ConversationID `json:"conversation_id"`
	WorkspaceID    WorkspaceID    `json:"workspace_id"`
	Label          string         `json:"label,omitempty"`

	// GitRef pins the commit in object storage to avoid GC.
	GitRef string `json:"git_ref,omitempty"`
	// CommitID is the snapshot commit captured at checkpoint creation.
	CommitID string `json:"commit_id"`
	// ParentCommitID is the workspace's HEAD commit when snapshot was created (if any).
	ParentCommitID string `json:"parent_commit_id,omitempty"`

	// PreexistingUntrackedFiles/Dirs are preserved during restore cleanup.
	PreexistingUntrackedFiles []string `json:"preexisting_untracked_files,omitempty"`
	PreexistingUntrackedDirs  []string `json:"preexisting_untracked_dirs,omitempty"`

	CreatedAt time.Time `json:"created_at"`
}
