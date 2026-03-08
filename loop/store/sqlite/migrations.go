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
		migrationMessageHistory,
		migrationUIEvents,
		migrationTimelineCursors,
		migrationCheckpoints,
	}
	for i, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			return fmt.Errorf("migration %d: %w", i, err)
		}
	}

	// Thread-fields migration runs each ALTER TABLE separately so it is
	// compatible with SQLite < 3.35 (which lacks ADD COLUMN IF NOT EXISTS).
	if err := migrateThreadFields(db); err != nil {
		return err
	}

	if err := migrateConversationPromptFields(db); err != nil {
		return err
	}

	// Timeline ordering migration adds shared ordering fields and backfills
	// deterministic values for existing rows.
	if err := migrateTimelineOrdering(db); err != nil {
		return err
	}

	if err := migrateConversationWorktreeField(db); err != nil {
		return err
	}

	return migrateBranchVersioning(db)
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
    system_prompt_id        TEXT NOT NULL DEFAULT '',
    system_prompt_name      TEXT NOT NULL DEFAULT '',
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
    timeline_seq        INTEGER NOT NULL DEFAULT 0,
    version             INTEGER NOT NULL DEFAULT 1,
    archived            BOOLEAN NOT NULL DEFAULT 0,
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

const migrationMessageHistory = `
CREATE TABLE IF NOT EXISTS message_history (
    id                     TEXT PRIMARY KEY,
    message_id             TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id        TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    version                INTEGER NOT NULL DEFAULT 1,
    archived               BOOLEAN NOT NULL DEFAULT 0,
    parts_json             TEXT NOT NULL DEFAULT '[]',
    metadata_json          TEXT NOT NULL DEFAULT '{}',
    attachments_json       TEXT NOT NULL DEFAULT '[]',
    created_by_message_id  TEXT NOT NULL DEFAULT '',
    created_at             DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_message_history_message_created
    ON message_history(message_id, created_at DESC);
`

const migrationUIEvents = `
CREATE TABLE IF NOT EXISTS ui_events (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      TEXT NOT NULL DEFAULT '',
    seq             INTEGER NOT NULL,
    timeline_seq    INTEGER NOT NULL DEFAULT 0,
    version         INTEGER NOT NULL DEFAULT 1,
    archived        BOOLEAN NOT NULL DEFAULT 0,
    kind            TEXT NOT NULL,
    text            TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      DATETIME NOT NULL DEFAULT (datetime('now')),
    UNIQUE(conversation_id, seq)
);

-- Primary lookup index: all events for a conversation in order.
CREATE INDEX IF NOT EXISTS idx_ui_events_conversation_seq
    ON ui_events(conversation_id, seq);

-- Secondary index: all events for a specific agent message.
CREATE INDEX IF NOT EXISTS idx_ui_events_message
    ON ui_events(message_id);
`

const migrationTimelineCursors = `
CREATE TABLE IF NOT EXISTS conversation_timeline_cursors (
    conversation_id   TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    next_timeline_seq INTEGER NOT NULL
);
`

const migrationCheckpoints = `
CREATE TABLE IF NOT EXISTS checkpoints (
    id                                  TEXT PRIMARY KEY,
    conversation_id                     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    workspace_id                        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    label                               TEXT NOT NULL DEFAULT '',
    git_ref                             TEXT NOT NULL DEFAULT '',
    commit_id                           TEXT NOT NULL,
    parent_commit_id                    TEXT NOT NULL DEFAULT '',
    preexisting_untracked_files_json    TEXT NOT NULL DEFAULT '[]',
    preexisting_untracked_dirs_json     TEXT NOT NULL DEFAULT '[]',
    created_at                          DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_conversation_created
    ON checkpoints(conversation_id, created_at DESC);
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

func migrateConversationPromptFields(db *sql.DB) error {
	alters := []string{
		`ALTER TABLE conversations ADD COLUMN system_prompt_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE conversations ADD COLUMN system_prompt_name TEXT NOT NULL DEFAULT ''`,
	}
	for _, stmt := range alters {
		if _, err := db.Exec(stmt); err != nil && !isDuplicateColumn(err) {
			return fmt.Errorf("conversation prompt fields migration: %w", err)
		}
	}
	return nil
}

func migrateConversationWorktreeField(db *sql.DB) error {
	alters := []string{
		`ALTER TABLE conversations ADD COLUMN worktree_path TEXT NOT NULL DEFAULT ''`,
	}
	for _, stmt := range alters {
		if _, err := db.Exec(stmt); err != nil && !isDuplicateColumn(err) {
			return fmt.Errorf("conversation worktree field migration: %w", err)
		}
	}
	return nil
}

func migrateTimelineOrdering(db *sql.DB) error {
	alters := []string{
		`ALTER TABLE messages ADD COLUMN timeline_seq INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE ui_events ADD COLUMN timeline_seq INTEGER NOT NULL DEFAULT 0`,
	}
	for _, stmt := range alters {
		if _, err := db.Exec(stmt); err != nil && !isDuplicateColumn(err) {
			return fmt.Errorf("timeline fields migration: %w", err)
		}
	}

	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_messages_conversation_timeline_seq
		 ON messages(conversation_id, timeline_seq)`,
		`CREATE INDEX IF NOT EXISTS idx_ui_events_conversation_timeline_seq
		 ON ui_events(conversation_id, timeline_seq)`,
	}
	for _, stmt := range indexes {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("timeline index migration: %w", err)
		}
	}

	convRows, err := db.Query(`
		SELECT conversation_id FROM messages
		UNION
		SELECT conversation_id FROM ui_events
	`)
	if err != nil {
		return fmt.Errorf("timeline backfill list conversations: %w", err)
	}
	defer convRows.Close()

	var conversationIDs []string
	for convRows.Next() {
		var convID string
		if err := convRows.Scan(&convID); err != nil {
			return fmt.Errorf("timeline backfill scan conversation: %w", err)
		}
		conversationIDs = append(conversationIDs, convID)
	}
	if err := convRows.Err(); err != nil {
		return fmt.Errorf("timeline backfill iterate conversations: %w", err)
	}

	for _, convID := range conversationIDs {
		if err := backfillTimelineSeqForConversation(db, convID); err != nil {
			return err
		}
	}
	return nil
}

func migrateBranchVersioning(db *sql.DB) error {
	alters := []string{
		`ALTER TABLE messages ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE messages ADD COLUMN archived BOOLEAN NOT NULL DEFAULT 0`,
		`ALTER TABLE ui_events ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE ui_events ADD COLUMN archived BOOLEAN NOT NULL DEFAULT 0`,
	}
	for _, stmt := range alters {
		if _, err := db.Exec(stmt); err != nil && !isDuplicateColumn(err) {
			return fmt.Errorf("branch versioning migration: %w", err)
		}
	}

	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_messages_conversation_archived_seq
		 ON messages(conversation_id, archived, seq)`,
		`CREATE INDEX IF NOT EXISTS idx_ui_events_conversation_archived_timeline
		 ON ui_events(conversation_id, archived, timeline_seq)`,
	}
	for _, stmt := range indexes {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("branch versioning index migration: %w", err)
		}
	}

	if _, err := db.Exec(migrationMessageHistory); err != nil {
		return fmt.Errorf("branch versioning message_history migration: %w", err)
	}

	return nil
}

type timelineRowRef struct {
	RowType  string
	ID       string
	LocalSeq int64
}

func backfillTimelineSeqForConversation(db *sql.DB, convID string) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("timeline backfill begin tx: %w", err)
	}
	defer tx.Rollback()

	rows, err := tx.Query(`
		SELECT row_type, row_id, local_seq
		FROM (
			SELECT 'message' AS row_type, id AS row_id, created_at, seq AS local_seq
			FROM messages
			WHERE conversation_id = ?
			UNION ALL
			SELECT 'ui_event' AS row_type, id AS row_id, created_at, seq AS local_seq
			FROM ui_events
			WHERE conversation_id = ?
		)
		ORDER BY created_at ASC,
		         CASE row_type WHEN 'message' THEN 0 ELSE 1 END ASC,
		         local_seq ASC,
		         row_id ASC
	`, convID, convID)
	if err != nil {
		return fmt.Errorf("timeline backfill query rows for %s: %w", convID, err)
	}
	defer rows.Close()

	refs := make([]timelineRowRef, 0)
	for rows.Next() {
		var ref timelineRowRef
		if err := rows.Scan(&ref.RowType, &ref.ID, &ref.LocalSeq); err != nil {
			return fmt.Errorf("timeline backfill scan rows for %s: %w", convID, err)
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("timeline backfill iterate rows for %s: %w", convID, err)
	}

	var seq int64 = 1
	for _, ref := range refs {
		var stmt string
		switch ref.RowType {
		case "message":
			stmt = `UPDATE messages SET timeline_seq = ? WHERE conversation_id = ? AND id = ?`
		case "ui_event":
			stmt = `UPDATE ui_events SET timeline_seq = ? WHERE conversation_id = ? AND id = ?`
		default:
			continue
		}
		if _, err := tx.Exec(stmt, seq, convID, ref.ID); err != nil {
			return fmt.Errorf("timeline backfill update %s %s in %s: %w", ref.RowType, ref.ID, convID, err)
		}
		seq++
	}

	if _, err := tx.Exec(`
		INSERT INTO conversation_timeline_cursors(conversation_id, next_timeline_seq)
		VALUES (?, ?)
		ON CONFLICT(conversation_id) DO UPDATE SET next_timeline_seq = excluded.next_timeline_seq
	`, convID, seq); err != nil {
		return fmt.Errorf("timeline backfill cursor for %s: %w", convID, err)
	}

	return tx.Commit()
}

// isDuplicateColumn returns true when SQLite reports a duplicate column name error.
func isDuplicateColumn(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "duplicate column name")
}
