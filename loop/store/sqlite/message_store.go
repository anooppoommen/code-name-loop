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

type sqliteMessageStore struct {
	writeDB *sql.DB
	readDB  *sql.DB
}

func (s *sqliteMessageStore) Append(ctx context.Context, msg *models.Message) error {
	now := time.Now().UTC()
	msg.CreatedAt = now
	msg.UpdatedAt = now

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Auto-assign the next monotonic sequence number for this conversation.
	var nextSeq int64
	err = tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?`,
		string(msg.ConversationID),
	).Scan(&nextSeq)
	if err != nil {
		return fmt.Errorf("compute next seq: %w", err)
	}
	msg.Seq = nextSeq

	timelineSeq, err := nextTimelineSeqTx(ctx, tx, string(msg.ConversationID))
	if err != nil {
		return fmt.Errorf("next timeline seq: %w", err)
	}
	msg.TimelineSeq = timelineSeq

	if msg.Version <= 0 {
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
		`, string(msg.ConversationID)).Scan(&msg.Version)
		if err != nil {
			return fmt.Errorf("resolve message version: %w", err)
		}
	}
	msg.Archived = false

	partsJSON, err := marshalJSON(msg.Parts)
	if err != nil {
		return fmt.Errorf("marshal parts: %w", err)
	}

	metaJSON, err := marshalMetadata(msg.Metadata)
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}

	attachJSON, err := marshalJSON(msg.Attachments)
	if err != nil {
		return fmt.Errorf("marshal attachments: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO messages
		 (id, conversation_id, seq, timeline_seq, version, archived, reply_to_message_id, state, sent_by,
		  parts_json, metadata_json, attachments_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		string(msg.ID),
		string(msg.ConversationID),
		msg.Seq,
		msg.TimelineSeq,
		msg.Version,
		msg.Archived,
		string(msg.ReplyToMessageID),
		string(msg.State),
		string(msg.SentBy),
		partsJSON,
		metaJSON,
		attachJSON,
		msg.CreatedAt,
		msg.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert message: %w", err)
	}

	// Update the conversation's head_message_id pointer.
	_, err = tx.ExecContext(ctx,
		`UPDATE conversations SET head_message_id = ?, updated_at = ? WHERE id = ?`,
		string(msg.ID), now, string(msg.ConversationID),
	)
	if err != nil {
		return fmt.Errorf("update head: %w", err)
	}

	// Set root_message_id if this is the first message (seq == 1).
	if msg.Seq == 1 {
		_, err = tx.ExecContext(ctx,
			`UPDATE conversations SET root_message_id = ? WHERE id = ? AND root_message_id = ''`,
			string(msg.ID), string(msg.ConversationID),
		)
		if err != nil {
			return fmt.Errorf("update root: %w", err)
		}
	}

	return tx.Commit()
}

func (s *sqliteMessageStore) Get(ctx context.Context, id models.MessageID) (*models.Message, error) {
	row := s.readDB.QueryRowContext(ctx,
		`SELECT id, conversation_id, seq, timeline_seq, version, archived, reply_to_message_id, state, sent_by,
		        parts_json, metadata_json, attachments_json, created_at, updated_at
		 FROM messages WHERE id = ?`, string(id))
	return scanMessage(row)
}

func (s *sqliteMessageStore) GetRange(ctx context.Context, convID models.ConversationID, fromSeq, toSeq int64) ([]*models.Message, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, conversation_id, seq, timeline_seq, version, archived, reply_to_message_id, state, sent_by,
		        parts_json, metadata_json, attachments_json, created_at, updated_at
		 FROM messages
		 WHERE conversation_id = ? AND archived = 0 AND seq BETWEEN ? AND ?
		 ORDER BY seq ASC`,
		string(convID), fromSeq, toSeq)
	if err != nil {
		return nil, fmt.Errorf("get range: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

func (s *sqliteMessageStore) GetRangeAll(ctx context.Context, convID models.ConversationID, fromSeq, toSeq int64) ([]*models.Message, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, conversation_id, seq, timeline_seq, version, archived, reply_to_message_id, state, sent_by,
		        parts_json, metadata_json, attachments_json, created_at, updated_at
		 FROM messages
		 WHERE conversation_id = ? AND seq BETWEEN ? AND ?
		 ORDER BY seq ASC`,
		string(convID), fromSeq, toSeq)
	if err != nil {
		return nil, fmt.Errorf("get range all: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

// GetParentHistory builds the full lineage from the root conversation down
// through all intermediate thread parents to the specified conversation,
// collecting message prefixes up to each anchor point.
//
// For example, if thread T2 is anchored at message C in conversation T1,
// and T1 is anchored at message X in root conversation R, then:
//
//	GetParentHistory(T2, seq) returns:
//	  R.messages[start..X.seq] ++ T1.messages[start..C.seq] ++ T2.messages[start..seq]
func (s *sqliteMessageStore) GetParentHistory(ctx context.Context, convID models.ConversationID, upToSeq int64) ([]*models.Message, error) {
	// Walk up the parent chain to collect (conversationID, maxSeq) pairs.
	type segment struct {
		convID models.ConversationID
		maxSeq int64
	}

	// Start with the leaf conversation.
	chain := []segment{{convID: convID, maxSeq: upToSeq}}

	currentConvID := convID
	for {
		// Load the conversation to check if it has a parent.
		var parentConvID, anchorMsgID string
		err := s.readDB.QueryRowContext(ctx,
			`SELECT parent_conversation_id, anchor_message_id
			 FROM conversations WHERE id = ?`, string(currentConvID),
		).Scan(&parentConvID, &anchorMsgID)
		if err != nil {
			return nil, fmt.Errorf("load conversation %s: %w", currentConvID, err)
		}

		if parentConvID == "" {
			// Reached a root conversation — done walking.
			break
		}

		// Look up the anchor message's seq in the parent conversation.
		var anchorSeq int64
		err = s.readDB.QueryRowContext(ctx,
			`SELECT seq FROM messages WHERE id = ? AND archived = 0`, anchorMsgID,
		).Scan(&anchorSeq)
		if err != nil {
			return nil, fmt.Errorf("anchor msg %s seq: %w", anchorMsgID, err)
		}

		chain = append(chain, segment{
			convID: models.ConversationID(parentConvID),
			maxSeq: anchorSeq,
		})
		currentConvID = models.ConversationID(parentConvID)
	}

	// Reverse the chain so root comes first.
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}

	// Collect messages from each segment.
	var result []*models.Message
	for _, seg := range chain {
		msgs, err := s.GetRange(ctx, seg.convID, 1, seg.maxSeq)
		if err != nil {
			return nil, fmt.Errorf("get segment %s: %w", seg.convID, err)
		}
		result = append(result, msgs...)
	}
	return result, nil
}

func (s *sqliteMessageStore) Update(ctx context.Context, msg *models.Message) error {
	msg.UpdatedAt = time.Now().UTC()

	partsJSON, err := marshalJSON(msg.Parts)
	if err != nil {
		return fmt.Errorf("marshal parts: %w", err)
	}
	metaJSON, err := marshalMetadata(msg.Metadata)
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}
	attachJSON, err := marshalJSON(msg.Attachments)
	if err != nil {
		return fmt.Errorf("marshal attachments: %w", err)
	}

	res, err := s.writeDB.ExecContext(ctx,
		`UPDATE messages
		 SET state = ?, sent_by = ?, reply_to_message_id = ?, version = ?, archived = ?,
		     parts_json = ?, metadata_json = ?, attachments_json = ?, updated_at = ?
		 WHERE id = ?`,
		string(msg.State),
		string(msg.SentBy),
		string(msg.ReplyToMessageID),
		msg.Version,
		msg.Archived,
		partsJSON,
		metaJSON,
		attachJSON,
		msg.UpdatedAt,
		string(msg.ID),
	)
	if err != nil {
		return fmt.Errorf("update message: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("message %s: not found", msg.ID)
	}
	return nil
}

func (s *sqliteMessageStore) BranchFromMessage(
	ctx context.Context,
	convID models.ConversationID,
	messageID models.MessageID,
	edit *models.MessageBranchEdit,
) (*models.Message, int64, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	target, err := scanMessage(tx.QueryRowContext(ctx,
		`SELECT id, conversation_id, seq, timeline_seq, version, archived, reply_to_message_id, state, sent_by,
		        parts_json, metadata_json, attachments_json, created_at, updated_at
		 FROM messages
		 WHERE id = ? AND conversation_id = ? AND archived = 0`,
		string(messageID), string(convID),
	))
	if err != nil {
		return nil, 0, fmt.Errorf("load branch message: %w", err)
	}

	if target.SentBy != models.SentByUser {
		return nil, 0, fmt.Errorf("message %s is not a user message", target.ID)
	}

	var nextVersion int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version), 1) + 1 FROM messages WHERE conversation_id = ?`,
		string(convID),
	).Scan(&nextVersion); err != nil {
		return nil, 0, fmt.Errorf("compute branch version: %w", err)
	}

	now := time.Now().UTC()

	if edit != nil {
		if err := insertMessageHistorySnapshotTx(ctx, tx, target, target.ID, now); err != nil {
			return nil, 0, err
		}

		parts := edit.Parts
		metadata := edit.Metadata
		attachments := edit.Attachments
		if metadata == nil {
			metadata = target.Metadata
		}
		if attachments == nil {
			attachments = target.Attachments
		}

		partsJSON, err := marshalJSON(parts)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal edited parts: %w", err)
		}
		metaJSON, err := marshalMetadata(metadata)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal edited metadata: %w", err)
		}
		attachJSON, err := marshalJSON(attachments)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal edited attachments: %w", err)
		}

		if _, err := tx.ExecContext(ctx,
			`UPDATE messages
			 SET parts_json = ?, metadata_json = ?, attachments_json = ?,
			     version = ?, archived = 0, updated_at = ?
			 WHERE id = ?`,
			partsJSON, metaJSON, attachJSON, nextVersion, now, string(target.ID),
		); err != nil {
			return nil, 0, fmt.Errorf("update edited message: %w", err)
		}

		target.Parts = parts
		target.Metadata = metadata
		target.Attachments = attachments
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE messages
		 SET archived = 1, updated_at = ?
		 WHERE conversation_id = ? AND seq > ? AND archived = 0`,
		now, string(convID), target.Seq,
	); err != nil {
		return nil, 0, fmt.Errorf("archive branch tail messages: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE ui_events
		 SET archived = 1
		 WHERE conversation_id = ? AND timeline_seq > ? AND archived = 0`,
		string(convID), target.TimelineSeq,
	); err != nil {
		return nil, 0, fmt.Errorf("archive branch tail ui_events: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE messages
		 SET version = ?, archived = 0, updated_at = ?
		 WHERE id = ?`,
		nextVersion, now, string(target.ID),
	); err != nil {
		return nil, 0, fmt.Errorf("update branch root message: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE conversations
		 SET head_message_id = ?, updated_at = ?
		 WHERE id = ?`,
		string(target.ID), now, string(convID),
	); err != nil {
		return nil, 0, fmt.Errorf("update conversation head: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, 0, fmt.Errorf("commit branch tx: %w", err)
	}

	target.Version = nextVersion
	target.Archived = false
	target.UpdatedAt = now
	return target, nextVersion, nil
}

func (s *sqliteMessageStore) GetHistory(ctx context.Context, messageID models.MessageID) ([]*models.MessageHistoryEntry, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, message_id, conversation_id, version, archived,
		        parts_json, metadata_json, attachments_json, created_by_message_id, created_at
		 FROM message_history
		 WHERE message_id = ?
		 ORDER BY created_at DESC, id DESC`,
		string(messageID),
	)
	if err != nil {
		return nil, fmt.Errorf("get message history: %w", err)
	}
	defer rows.Close()

	result := make([]*models.MessageHistoryEntry, 0)
	for rows.Next() {
		entry := &models.MessageHistoryEntry{}
		var partsJSON, metaJSON, attachJSON string
		if err := rows.Scan(
			&entry.ID,
			&entry.MessageID,
			&entry.ConversationID,
			&entry.Version,
			&entry.Archived,
			&partsJSON,
			&metaJSON,
			&attachJSON,
			&entry.CreatedByID,
			&entry.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan message history: %w", err)
		}
		if err := json.Unmarshal([]byte(partsJSON), &entry.Parts); err != nil {
			return nil, fmt.Errorf("unmarshal message history parts: %w", err)
		}
		if err := json.Unmarshal([]byte(metaJSON), &entry.Metadata); err != nil {
			return nil, fmt.Errorf("unmarshal message history metadata: %w", err)
		}
		if err := json.Unmarshal([]byte(attachJSON), &entry.Attachments); err != nil {
			return nil, fmt.Errorf("unmarshal message history attachments: %w", err)
		}
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate message history: %w", err)
	}
	return result, nil
}

func insertMessageHistorySnapshotTx(
	ctx context.Context,
	tx *sql.Tx,
	msg *models.Message,
	createdByMessageID models.MessageID,
	createdAt time.Time,
) error {
	partsJSON, err := marshalJSON(msg.Parts)
	if err != nil {
		return fmt.Errorf("marshal history parts: %w", err)
	}
	metaJSON, err := marshalMetadata(msg.Metadata)
	if err != nil {
		return fmt.Errorf("marshal history metadata: %w", err)
	}
	attachJSON, err := marshalJSON(msg.Attachments)
	if err != nil {
		return fmt.Errorf("marshal history attachments: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO message_history
		 (id, message_id, conversation_id, version, archived, parts_json, metadata_json, attachments_json, created_by_message_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uuid.New().String(),
		string(msg.ID),
		string(msg.ConversationID),
		msg.Version,
		msg.Archived,
		partsJSON,
		metaJSON,
		attachJSON,
		string(createdByMessageID),
		createdAt,
	); err != nil {
		return fmt.Errorf("insert message history: %w", err)
	}
	return nil
}

func (s *sqliteMessageStore) Delete(ctx context.Context, id models.MessageID) error {
	res, err := s.writeDB.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, string(id))
	if err != nil {
		return fmt.Errorf("delete message: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("message %s: not found", id)
	}
	return nil
}

// ----- scan helpers -----

func scanMessage(row *sql.Row) (*models.Message, error) {
	msg := &models.Message{}
	var partsJSON, metaJSON, attachJSON string
	err := row.Scan(
		&msg.ID, &msg.ConversationID, &msg.Seq, &msg.TimelineSeq, &msg.Version, &msg.Archived, &msg.ReplyToMessageID,
		&msg.State, &msg.SentBy,
		&partsJSON, &metaJSON, &attachJSON,
		&msg.CreatedAt, &msg.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("message not found")
	}
	if err != nil {
		return nil, fmt.Errorf("scan message: %w", err)
	}

	if err := json.Unmarshal([]byte(partsJSON), &msg.Parts); err != nil {
		return nil, fmt.Errorf("unmarshal parts: %w", err)
	}
	if err := json.Unmarshal([]byte(metaJSON), &msg.Metadata); err != nil {
		return nil, fmt.Errorf("unmarshal metadata: %w", err)
	}
	if err := json.Unmarshal([]byte(attachJSON), &msg.Attachments); err != nil {
		return nil, fmt.Errorf("unmarshal attachments: %w", err)
	}
	return msg, nil
}

func scanMessages(rows *sql.Rows) ([]*models.Message, error) {
	result := make([]*models.Message, 0)
	for rows.Next() {
		msg := &models.Message{}
		var partsJSON, metaJSON, attachJSON string
		if err := rows.Scan(
			&msg.ID, &msg.ConversationID, &msg.Seq, &msg.TimelineSeq, &msg.Version, &msg.Archived, &msg.ReplyToMessageID,
			&msg.State, &msg.SentBy,
			&partsJSON, &metaJSON, &attachJSON,
			&msg.CreatedAt, &msg.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		if err := json.Unmarshal([]byte(partsJSON), &msg.Parts); err != nil {
			return nil, fmt.Errorf("unmarshal parts: %w", err)
		}
		if err := json.Unmarshal([]byte(metaJSON), &msg.Metadata); err != nil {
			return nil, fmt.Errorf("unmarshal metadata: %w", err)
		}
		if err := json.Unmarshal([]byte(attachJSON), &msg.Attachments); err != nil {
			return nil, fmt.Errorf("unmarshal attachments: %w", err)
		}
		result = append(result, msg)
	}
	return result, rows.Err()
}

func marshalMetadata(m map[string]any) (string, error) {
	if m == nil {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
