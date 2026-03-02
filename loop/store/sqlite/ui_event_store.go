package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"loop/models"
)

type sqliteUIEventStore struct {
	writeDB *sql.DB
	readDB  *sql.DB
}

func (s *sqliteUIEventStore) Append(ctx context.Context, evt *models.UIEvent) error {
	if evt.ID == "" {
		evt.ID = uuid.New().String()
	}
	evt.CreatedAt = time.Now().UTC()

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Auto-assign the next monotonic sequence number for this conversation.
	var nextSeq int64
	err = tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq), 0) + 1 FROM ui_events WHERE conversation_id = ?`,
		string(evt.ConversationID),
	).Scan(&nextSeq)
	if err != nil {
		return fmt.Errorf("compute next seq: %w", err)
	}
	evt.Seq = nextSeq

	timelineSeq, err := nextTimelineSeqTx(ctx, tx, string(evt.ConversationID))
	if err != nil {
		return fmt.Errorf("next timeline seq: %w", err)
	}
	evt.TimelineSeq = timelineSeq

	if evt.Version <= 0 {
		err = tx.QueryRowContext(ctx, `
			SELECT COALESCE((
				SELECT m.version
				FROM messages m
				WHERE m.id = (
					SELECT head_message_id
					FROM conversations
					WHERE id = ?
				)
			), 1)
		`, string(evt.ConversationID)).Scan(&evt.Version)
		if err != nil {
			return fmt.Errorf("resolve ui_event version: %w", err)
		}
	}
	evt.Archived = false

	metaJSON, err := marshalJSON(evt.Metadata)
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO ui_events
		 (id, conversation_id, message_id, seq, timeline_seq, version, archived, kind, text, metadata_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		evt.ID,
		string(evt.ConversationID),
		string(evt.MessageID),
		evt.Seq,
		evt.TimelineSeq,
		evt.Version,
		evt.Archived,
		string(evt.Kind),
		evt.Text,
		metaJSON,
		evt.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert ui_event: %w", err)
	}

	return tx.Commit()
}

func (s *sqliteUIEventStore) GetByConversation(ctx context.Context, convID models.ConversationID) ([]*models.UIEvent, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, conversation_id, message_id, seq, timeline_seq, version, archived, kind, text, metadata_json, created_at
		 FROM ui_events
		 WHERE conversation_id = ? AND archived = 0
		 ORDER BY timeline_seq ASC, seq ASC`,
		string(convID),
	)
	if err != nil {
		return nil, fmt.Errorf("get ui_events by conversation: %w", err)
	}
	defer rows.Close()
	return scanUIEvents(rows)
}

func (s *sqliteUIEventStore) GetByConversationAll(ctx context.Context, convID models.ConversationID) ([]*models.UIEvent, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, conversation_id, message_id, seq, timeline_seq, version, archived, kind, text, metadata_json, created_at
		 FROM ui_events
		 WHERE conversation_id = ?
		 ORDER BY timeline_seq ASC, seq ASC`,
		string(convID),
	)
	if err != nil {
		return nil, fmt.Errorf("get all ui_events by conversation: %w", err)
	}
	defer rows.Close()
	return scanUIEvents(rows)
}

func (s *sqliteUIEventStore) GetByMessage(ctx context.Context, msgID models.MessageID) ([]*models.UIEvent, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, conversation_id, message_id, seq, timeline_seq, version, archived, kind, text, metadata_json, created_at
		 FROM ui_events
		 WHERE message_id = ? AND archived = 0
		 ORDER BY timeline_seq ASC, seq ASC`,
		string(msgID),
	)
	if err != nil {
		return nil, fmt.Errorf("get ui_events by message: %w", err)
	}
	defer rows.Close()
	return scanUIEvents(rows)
}

// ----- scan helpers -----

func scanUIEvents(rows *sql.Rows) ([]*models.UIEvent, error) {
	var result []*models.UIEvent
	for rows.Next() {
		evt := &models.UIEvent{}
		var metaJSON string
		if err := rows.Scan(
			&evt.ID, &evt.ConversationID, &evt.MessageID,
			&evt.Seq, &evt.TimelineSeq, &evt.Version, &evt.Archived, &evt.Kind, &evt.Text,
			&metaJSON, &evt.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan ui_event: %w", err)
		}
		if err := json.Unmarshal([]byte(metaJSON), &evt.Metadata); err != nil {
			return nil, fmt.Errorf("unmarshal ui_event metadata: %w", err)
		}
		result = append(result, evt)
	}
	return result, rows.Err()
}
