package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"loop/models"
)

type sqliteCheckpointStore struct {
	writeDB *sql.DB
	readDB  *sql.DB
}

func (s *sqliteCheckpointStore) Create(ctx context.Context, cp *models.Checkpoint) error {
	cp.CreatedAt = time.Now().UTC()

	filesJSON, err := marshalJSON(cp.PreexistingUntrackedFiles)
	if err != nil {
		return fmt.Errorf("marshal preexisting files: %w", err)
	}
	dirsJSON, err := marshalJSON(cp.PreexistingUntrackedDirs)
	if err != nil {
		return fmt.Errorf("marshal preexisting dirs: %w", err)
	}

	_, err = s.writeDB.ExecContext(ctx,
		`INSERT INTO checkpoints
		 (id, conversation_id, workspace_id, label, git_ref, commit_id, parent_commit_id,
		  preexisting_untracked_files_json, preexisting_untracked_dirs_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		cp.ID,
		string(cp.ConversationID),
		string(cp.WorkspaceID),
		cp.Label,
		cp.GitRef,
		cp.CommitID,
		cp.ParentCommitID,
		filesJSON,
		dirsJSON,
		cp.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert checkpoint: %w", err)
	}
	return nil
}

func (s *sqliteCheckpointStore) Get(ctx context.Context, id string) (*models.Checkpoint, error) {
	row := s.readDB.QueryRowContext(ctx,
		`SELECT id, conversation_id, workspace_id, label, git_ref, commit_id, parent_commit_id,
		        preexisting_untracked_files_json, preexisting_untracked_dirs_json, created_at
		 FROM checkpoints WHERE id = ?`,
		id,
	)
	return scanCheckpoint(row)
}

func (s *sqliteCheckpointStore) ListByConversation(ctx context.Context, convID models.ConversationID, limit int) ([]*models.Checkpoint, error) {
	if limit <= 0 {
		limit = 20
	}

	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, conversation_id, workspace_id, label, git_ref, commit_id, parent_commit_id,
		        preexisting_untracked_files_json, preexisting_untracked_dirs_json, created_at
		 FROM checkpoints
		 WHERE conversation_id = ?
		 ORDER BY created_at DESC, id DESC
		 LIMIT ?`,
		string(convID), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list checkpoints: %w", err)
	}
	defer rows.Close()
	return scanCheckpoints(rows)
}

func (s *sqliteCheckpointStore) LatestByConversation(ctx context.Context, convID models.ConversationID) (*models.Checkpoint, error) {
	row := s.readDB.QueryRowContext(ctx,
		`SELECT id, conversation_id, workspace_id, label, git_ref, commit_id, parent_commit_id,
		        preexisting_untracked_files_json, preexisting_untracked_dirs_json, created_at
		 FROM checkpoints
		 WHERE conversation_id = ?
		 ORDER BY created_at DESC, id DESC
		 LIMIT 1`,
		string(convID),
	)
	return scanCheckpoint(row)
}

func (s *sqliteCheckpointStore) Delete(ctx context.Context, id string) error {
	res, err := s.writeDB.ExecContext(ctx, `DELETE FROM checkpoints WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete checkpoint: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return fmt.Errorf("checkpoint %s: not found", id)
	}
	return nil
}

func (s *sqliteCheckpointStore) PruneByConversation(ctx context.Context, convID models.ConversationID, keep int) error {
	if keep < 0 {
		keep = 0
	}

	_, err := s.writeDB.ExecContext(ctx,
		`DELETE FROM checkpoints
		 WHERE conversation_id = ?
		   AND id IN (
		     SELECT id FROM checkpoints
		     WHERE conversation_id = ?
		     ORDER BY created_at DESC, id DESC
		     LIMIT -1 OFFSET ?
		   )`,
		string(convID), string(convID), keep,
	)
	if err != nil {
		return fmt.Errorf("prune checkpoints: %w", err)
	}
	return nil
}

func scanCheckpoint(row *sql.Row) (*models.Checkpoint, error) {
	cp := &models.Checkpoint{}
	var filesJSON, dirsJSON string
	err := row.Scan(
		&cp.ID,
		&cp.ConversationID,
		&cp.WorkspaceID,
		&cp.Label,
		&cp.GitRef,
		&cp.CommitID,
		&cp.ParentCommitID,
		&filesJSON,
		&dirsJSON,
		&cp.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("checkpoint not found")
	}
	if err != nil {
		return nil, fmt.Errorf("scan checkpoint: %w", err)
	}
	if err := json.Unmarshal([]byte(filesJSON), &cp.PreexistingUntrackedFiles); err != nil {
		return nil, fmt.Errorf("unmarshal checkpoint preexisting files: %w", err)
	}
	if err := json.Unmarshal([]byte(dirsJSON), &cp.PreexistingUntrackedDirs); err != nil {
		return nil, fmt.Errorf("unmarshal checkpoint preexisting dirs: %w", err)
	}
	return cp, nil
}

func scanCheckpoints(rows *sql.Rows) ([]*models.Checkpoint, error) {
	var result []*models.Checkpoint
	for rows.Next() {
		cp := &models.Checkpoint{}
		var filesJSON, dirsJSON string
		if err := rows.Scan(
			&cp.ID,
			&cp.ConversationID,
			&cp.WorkspaceID,
			&cp.Label,
			&cp.GitRef,
			&cp.CommitID,
			&cp.ParentCommitID,
			&filesJSON,
			&dirsJSON,
			&cp.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan checkpoint: %w", err)
		}
		if err := json.Unmarshal([]byte(filesJSON), &cp.PreexistingUntrackedFiles); err != nil {
			return nil, fmt.Errorf("unmarshal checkpoint preexisting files: %w", err)
		}
		if err := json.Unmarshal([]byte(dirsJSON), &cp.PreexistingUntrackedDirs); err != nil {
			return nil, fmt.Errorf("unmarshal checkpoint preexisting dirs: %w", err)
		}
		result = append(result, cp)
	}
	return result, rows.Err()
}
