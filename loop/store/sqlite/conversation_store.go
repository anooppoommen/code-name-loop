package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"loop/models"
)

type sqliteConversationStore struct {
	writeDB *sql.DB
	readDB  *sql.DB
}

func (s *sqliteConversationStore) Create(ctx context.Context, conv *models.Conversation) error {
	now := time.Now().UTC()
	conv.CreatedAt = now
	conv.UpdatedAt = now

	_, err := s.writeDB.ExecContext(ctx,
		`INSERT INTO conversations
		 (id, workspace_id, title, parent_conversation_id, anchor_message_id,
		  root_message_id, head_message_id,
		  thread_mode, thread_status, context_strategy, result_message,
		  created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		string(conv.ID),
		string(conv.WorkspaceID),
		conv.Title,
		string(conv.ParentConversationID),
		string(conv.AnchorMessageID),
		string(conv.RootMessageID),
		string(conv.HeadMessageID),
		string(conv.ThreadMode),
		string(conv.ThreadStatus),
		string(conv.ContextStrategy),
		conv.ResultMessage,
		conv.CreatedAt,
		conv.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert conversation: %w", err)
	}
	return nil
}

func (s *sqliteConversationStore) Get(ctx context.Context, id models.ConversationID) (*models.Conversation, error) {
	conv := &models.Conversation{}
	err := s.readDB.QueryRowContext(ctx,
		`SELECT id, workspace_id, title, parent_conversation_id, anchor_message_id,
		        root_message_id, head_message_id,
		        thread_mode, thread_status, context_strategy, result_message,
		        created_at, updated_at
		 FROM conversations WHERE id = ?`, string(id),
	).Scan(
		&conv.ID, &conv.WorkspaceID, &conv.Title,
		&conv.ParentConversationID, &conv.AnchorMessageID,
		&conv.RootMessageID, &conv.HeadMessageID,
		&conv.ThreadMode, &conv.ThreadStatus, &conv.ContextStrategy, &conv.ResultMessage,
		&conv.CreatedAt, &conv.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("conversation %s: not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get conversation: %w", err)
	}
	return conv, nil
}

func (s *sqliteConversationStore) ListByWorkspace(ctx context.Context, wsID models.WorkspaceID) ([]*models.Conversation, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, workspace_id, title, parent_conversation_id, anchor_message_id,
		        root_message_id, head_message_id,
		        thread_mode, thread_status, context_strategy, result_message,
		        created_at, updated_at
		 FROM conversations WHERE workspace_id = ?
		 ORDER BY created_at ASC`, string(wsID))
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	defer rows.Close()
	return scanConversations(rows)
}

func (s *sqliteConversationStore) ListThreads(ctx context.Context, parentConvID models.ConversationID) ([]*models.Conversation, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, workspace_id, title, parent_conversation_id, anchor_message_id,
		        root_message_id, head_message_id,
		        thread_mode, thread_status, context_strategy, result_message,
		        created_at, updated_at
		 FROM conversations WHERE parent_conversation_id = ?
		 ORDER BY created_at ASC`, string(parentConvID))
	if err != nil {
		return nil, fmt.Errorf("list threads: %w", err)
	}
	defer rows.Close()
	return scanConversations(rows)
}

func (s *sqliteConversationStore) Update(ctx context.Context, conv *models.Conversation) error {
	conv.UpdatedAt = time.Now().UTC()

	res, err := s.writeDB.ExecContext(ctx,
		`UPDATE conversations
		 SET title = ?, parent_conversation_id = ?, anchor_message_id = ?,
		     root_message_id = ?, head_message_id = ?,
		     thread_mode = ?, thread_status = ?, context_strategy = ?, result_message = ?,
		     updated_at = ?
		 WHERE id = ?`,
		conv.Title,
		string(conv.ParentConversationID),
		string(conv.AnchorMessageID),
		string(conv.RootMessageID),
		string(conv.HeadMessageID),
		string(conv.ThreadMode),
		string(conv.ThreadStatus),
		string(conv.ContextStrategy),
		conv.ResultMessage,
		conv.UpdatedAt,
		string(conv.ID),
	)
	if err != nil {
		return fmt.Errorf("update conversation: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("conversation %s: not found", conv.ID)
	}
	return nil
}

func (s *sqliteConversationStore) Delete(ctx context.Context, id models.ConversationID) error {
	res, err := s.writeDB.ExecContext(ctx, `DELETE FROM conversations WHERE id = ?`, string(id))
	if err != nil {
		return fmt.Errorf("delete conversation: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("conversation %s: not found", id)
	}
	return nil
}

// ----- helpers -----

func scanConversations(rows *sql.Rows) ([]*models.Conversation, error) {
	result := make([]*models.Conversation, 0)
	for rows.Next() {
		conv := &models.Conversation{}
		if err := rows.Scan(
			&conv.ID, &conv.WorkspaceID, &conv.Title,
			&conv.ParentConversationID, &conv.AnchorMessageID,
			&conv.RootMessageID, &conv.HeadMessageID,
			&conv.ThreadMode, &conv.ThreadStatus, &conv.ContextStrategy, &conv.ResultMessage,
			&conv.CreatedAt, &conv.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan conversation: %w", err)
		}
		result = append(result, conv)
	}
	return result, rows.Err()
}
