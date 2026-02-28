package models

import "time"

// Workspace represents a filesystem-rooted project context for the coding agent.
// It is the top-level organizational unit under which conversations occur.
type Workspace struct {
	ID WorkspaceID

	// Human-friendly name; defaults to the base folder name of RootPath.
	Name string

	// Declared root path as configured/created by the user.
	RootPath string

	// Canonical root path used for durable identity and lookup.
	// Derived via a well-defined canonicalization policy at creation time
	// (resolving symlinks, removing trailing slashes, etc.).
	CanonicalRootPath string

	// PathGrants describe extra filesystem access outside RootPath
	// (or narrower exceptions inside it).
	PathGrants []PathGrant

	// Root conversation IDs under this workspace.
	// Threads are separate conversations with ParentConversationID set.
	ConversationRoots []ConversationID

	CreatedAt time.Time
	UpdatedAt time.Time
}

// PathGrant expresses a least-privilege filesystem permission that extends
// (or restricts) the default workspace root boundary.
type PathGrant struct {
	// Canonical absolute path on the server filesystem.
	CanonicalPath string

	// Original path as provided by the user/config, preserved for display.
	DeclaredPath string

	// Whether this grant covers a directory subtree or a single file.
	// The enforcement layer treats directory grants as prefix constraints
	// after canonicalization.
	IsDirectory bool

	// Read vs write — the minimum distinction needed for least privilege.
	Mode PathAccessMode
}
