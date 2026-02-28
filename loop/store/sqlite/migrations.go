package sqlite

import (
	"database/sql"
	"fmt"
	"strings"
)

// migrate runs all schema migrations idempotently.
func migrate(db *sql.DB) error {
	migrations := []string{
		migrationWorkspaces,
		migrationPathGrants,
		migrationConversations,
		migrationMessages,
	}
	for i, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			return fmt.Errorf("migration %d: %w", i, err)
		}
	}
	// Thread-fields migration runs each ALTER TABLE separately so it is
	// compatible with SQLite < 3.35 (which lacks ADD COLUMN IF NOT EXISTS).
	return migrateThreadFields(db)
}

const migrationWorkspaces = `
CREATE TABLE IF NOT EXISTS workspaces (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL DEFAULT '',
    root_path           TEXT NOT NULL,
    canonical_root_path TEXT NOT NULL,
    created_at          DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at          DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Fast lookup by canonical root path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_canonical_root_path
    ON workspaces(canonical_root_path);
`

const migrationPathGrants = `
CREATE TABLE IF NOT EXISTS path_grants (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    canonical_path  TEXT NOT NULL,
    declared_path   TEXT NOT NULL DEFAULT '',
    is_directory    BOOLEAN NOT NULL DEFAULT 0,
    mode            TEXT NOT NULL DEFAULT 'read'
);

CREATE INDEX IF NOT EXISTS idx_path_grants_workspace
    ON path_grants(workspace_id);
`

const migrationConversations = `
CREATE TABLE IF NOT EXISTS conversations (
    id                      TEXT PRIMARY KEY,
    workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title                   TEXT NOT NULL DEFAULT '',
    parent_conversation_id  TEXT NOT NULL DEFAULT '',
    anchor_message_id       TEXT NOT NULL DEFAULT '',
    root_message_id         TEXT NOT NULL DEFAULT '',
    head_message_id         TEXT NOT NULL DEFAULT '',
    created_at              DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at              DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_workspace
    ON conversations(workspace_id);

CREATE INDEX IF NOT EXISTS idx_conversations_parent
    ON conversations(parent_conversation_id);
`

const migrationMessages = `
CREATE TABLE IF NOT EXISTS messages (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq                 INTEGER NOT NULL,
    reply_to_message_id TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL DEFAULT 'pending',
    sent_by             TEXT NOT NULL,
    parts_json          TEXT NOT NULL DEFAULT '[]',
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    attachments_json    TEXT NOT NULL DEFAULT '[]',
    created_at          DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at          DATETIME NOT NULL DEFAULT (datetime('now')),
    UNIQUE(conversation_id, seq)
);

-- Primary range query index: conversation + seq range.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
    ON messages(conversation_id, seq);
`

// migrateThreadFields adds sub-agent lifecycle columns to the conversations table.
// Each ALTER TABLE is executed separately and "duplicate column" errors are ignored,
// making this compatible with all SQLite versions (pre-3.35 lacks ADD COLUMN IF NOT EXISTS).
func migrateThreadFields(db *sql.DB) error {
	alters := []string{
		`ALTER TABLE conversations ADD COLUMN thread_mode      TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE conversations ADD COLUMN thread_status    TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE conversations ADD COLUMN context_strategy TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE conversations ADD COLUMN result_message   TEXT NOT NULL DEFAULT ''`,
	}
	for _, stmt := range alters {
		if _, err := db.Exec(stmt); err != nil {
			// "duplicate column name" means the column already exists — idempotent.
			if !isDuplicateColumn(err) {
				return fmt.Errorf("thread fields migration: %w", err)
			}
		}
	}
	return nil
}

// isDuplicateColumn returns true when SQLite reports a duplicate column name error.
func isDuplicateColumn(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "duplicate column name")
}
