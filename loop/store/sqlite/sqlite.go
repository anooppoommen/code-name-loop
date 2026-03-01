// Package sqlite implements the store interfaces using SQLite with WAL mode
// for concurrent read/write access.
//
// Architecture: Two connection pools are used —
//   - writeDB: MaxOpenConns(1) for serialized writes (transactions)
//   - readDB:  Unlimited connections for concurrent reads
//
// This is the standard Go pattern for SQLite WAL mode and eliminates
// "database is locked" errors under concurrent load.
package sqlite

import (
	"database/sql"
	"fmt"

	"loop/store"

	_ "github.com/mattn/go-sqlite3"
)

// SQLiteStore implements store.Store backed by a SQLite database.
type SQLiteStore struct {
	writeDB *sql.DB
	readDB  *sql.DB

	workspaces    *sqliteWorkspaceStore
	conversations *sqliteConversationStore
	messages      *sqliteMessageStore
	uiEvents      *sqliteUIEventStore
	checkpoints   *sqliteCheckpointStore
}

// New opens (or creates) a SQLite database at the given path,
// configures WAL journal mode for concurrent reads/writes,
// runs migrations, and returns a ready-to-use Store.
func New(dbPath string) (store.Store, error) {
	// Base DSN with pragmas:
	//   _journal_mode=WAL     — allows concurrent readers alongside one writer
	//   _busy_timeout=5000    — wait up to 5 s instead of returning SQLITE_BUSY immediately
	//   _foreign_keys=ON      — enforce referential integrity
	//   _synchronous=NORMAL   — safe for WAL mode, good balance of safety/speed
	baseDSN := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON&_synchronous=NORMAL", dbPath)

	// --- Write connection (single writer, serialized) ---
	writeDB, err := sql.Open("sqlite3", baseDSN+"&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("sqlite open write: %w", err)
	}
	// Only one connection for writes to avoid SQLITE_BUSY between writers.
	writeDB.SetMaxOpenConns(1)

	if err := writeDB.Ping(); err != nil {
		writeDB.Close()
		return nil, fmt.Errorf("sqlite ping write: %w", err)
	}

	// Explicitly set WAL mode (some drivers need a direct PRAGMA statement).
	if _, err := writeDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		writeDB.Close()
		return nil, fmt.Errorf("sqlite set WAL: %w", err)
	}

	// --- Read connection pool (unlimited concurrent readers) ---
	readDB, err := sql.Open("sqlite3", baseDSN+"&mode=ro")
	if err != nil {
		writeDB.Close()
		return nil, fmt.Errorf("sqlite open read: %w", err)
	}

	if err := readDB.Ping(); err != nil {
		writeDB.Close()
		readDB.Close()
		return nil, fmt.Errorf("sqlite ping read: %w", err)
	}

	// Run schema migrations on the write connection.
	if err := migrate(writeDB); err != nil {
		writeDB.Close()
		readDB.Close()
		return nil, fmt.Errorf("sqlite migrate: %w", err)
	}

	s := &SQLiteStore{writeDB: writeDB, readDB: readDB}
	s.workspaces = &sqliteWorkspaceStore{writeDB: writeDB, readDB: readDB}
	s.conversations = &sqliteConversationStore{writeDB: writeDB, readDB: readDB}
	s.messages = &sqliteMessageStore{writeDB: writeDB, readDB: readDB}
	s.uiEvents = &sqliteUIEventStore{writeDB: writeDB, readDB: readDB}
	s.checkpoints = &sqliteCheckpointStore{writeDB: writeDB, readDB: readDB}

	return s, nil
}

func (s *SQLiteStore) Workspaces() store.WorkspaceStore       { return s.workspaces }
func (s *SQLiteStore) Conversations() store.ConversationStore { return s.conversations }
func (s *SQLiteStore) Messages() store.MessageStore           { return s.messages }
func (s *SQLiteStore) UIEvents() store.UIEventStore           { return s.uiEvents }
func (s *SQLiteStore) Checkpoints() store.CheckpointStore     { return s.checkpoints }

func (s *SQLiteStore) Close() error {
	rerr := s.readDB.Close()
	werr := s.writeDB.Close()
	if werr != nil {
		return werr
	}
	return rerr
}
