package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"loop/models"
)

type sqliteWorkspaceStore struct {
	writeDB *sql.DB
	readDB  *sql.DB
}

func (s *sqliteWorkspaceStore) Create(ctx context.Context, ws *models.Workspace) error {
	now := time.Now().UTC()
	ws.CreatedAt = now
	ws.UpdatedAt = now

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx,
		`INSERT INTO workspaces (id, name, root_path, canonical_root_path, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		string(ws.ID), ws.Name, ws.RootPath, ws.CanonicalRootPath, ws.CreatedAt, ws.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert workspace: %w", err)
	}

	if err := insertPathGrants(ctx, tx, ws.ID, ws.PathGrants); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *sqliteWorkspaceStore) Get(ctx context.Context, id models.WorkspaceID) (*models.Workspace, error) {
	ws := &models.Workspace{}
	err := s.readDB.QueryRowContext(ctx,
		`SELECT id, name, root_path, canonical_root_path, created_at, updated_at
		 FROM workspaces WHERE id = ?`, string(id),
	).Scan(&ws.ID, &ws.Name, &ws.RootPath, &ws.CanonicalRootPath, &ws.CreatedAt, &ws.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("workspace %s: not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace: %w", err)
	}

	grants, err := loadPathGrants(ctx, s.readDB, ws.ID)
	if err != nil {
		return nil, err
	}
	ws.PathGrants = grants

	roots, err := loadConversationRoots(ctx, s.readDB, ws.ID)
	if err != nil {
		return nil, err
	}
	ws.ConversationRoots = roots

	return ws, nil
}

func (s *sqliteWorkspaceStore) GetByRootPath(ctx context.Context, canonicalPath string) (*models.Workspace, error) {
	var id models.WorkspaceID
	err := s.readDB.QueryRowContext(ctx,
		`SELECT id FROM workspaces WHERE canonical_root_path = ?`, canonicalPath,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("workspace with root %s: not found", canonicalPath)
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace by root: %w", err)
	}
	return s.Get(ctx, id)
}

func (s *sqliteWorkspaceStore) Update(ctx context.Context, ws *models.Workspace) error {
	ws.UpdatedAt = time.Now().UTC()

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`UPDATE workspaces SET name = ?, root_path = ?, canonical_root_path = ?, updated_at = ?
		 WHERE id = ?`,
		ws.Name, ws.RootPath, ws.CanonicalRootPath, ws.UpdatedAt, string(ws.ID),
	)
	if err != nil {
		return fmt.Errorf("update workspace: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("workspace %s: not found", ws.ID)
	}

	// Replace path grants atomically.
	if _, err := tx.ExecContext(ctx, `DELETE FROM path_grants WHERE workspace_id = ?`, string(ws.ID)); err != nil {
		return fmt.Errorf("delete path grants: %w", err)
	}
	if err := insertPathGrants(ctx, tx, ws.ID, ws.PathGrants); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *sqliteWorkspaceStore) Delete(ctx context.Context, id models.WorkspaceID) error {
	res, err := s.writeDB.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, string(id))
	if err != nil {
		return fmt.Errorf("delete workspace: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("workspace %s: not found", id)
	}
	return nil
}

func (s *sqliteWorkspaceStore) List(ctx context.Context) ([]*models.Workspace, error) {
	rows, err := s.readDB.QueryContext(ctx,
		`SELECT id, name, root_path, canonical_root_path, created_at, updated_at
		 FROM workspaces ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	defer rows.Close()

	var result []*models.Workspace
	for rows.Next() {
		ws := &models.Workspace{}
		if err := rows.Scan(&ws.ID, &ws.Name, &ws.RootPath, &ws.CanonicalRootPath, &ws.CreatedAt, &ws.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		grants, err := loadPathGrants(ctx, s.readDB, ws.ID)
		if err != nil {
			return nil, err
		}
		ws.PathGrants = grants
		result = append(result, ws)
	}
	return result, rows.Err()
}

// ----- helpers -----

func insertPathGrants(ctx context.Context, tx *sql.Tx, wsID models.WorkspaceID, grants []models.PathGrant) error {
	for _, g := range grants {
		_, err := tx.ExecContext(ctx,
			`INSERT INTO path_grants (workspace_id, canonical_path, declared_path, is_directory, mode)
			 VALUES (?, ?, ?, ?, ?)`,
			string(wsID), g.CanonicalPath, g.DeclaredPath, g.IsDirectory, string(g.Mode),
		)
		if err != nil {
			return fmt.Errorf("insert path grant: %w", err)
		}
	}
	return nil
}

func loadPathGrants(ctx context.Context, db *sql.DB, wsID models.WorkspaceID) ([]models.PathGrant, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT canonical_path, declared_path, is_directory, mode
		 FROM path_grants WHERE workspace_id = ?`, string(wsID))
	if err != nil {
		return nil, fmt.Errorf("load path grants: %w", err)
	}
	defer rows.Close()

	var grants []models.PathGrant
	for rows.Next() {
		var g models.PathGrant
		if err := rows.Scan(&g.CanonicalPath, &g.DeclaredPath, &g.IsDirectory, &g.Mode); err != nil {
			return nil, fmt.Errorf("scan path grant: %w", err)
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

func loadConversationRoots(ctx context.Context, db *sql.DB, wsID models.WorkspaceID) ([]models.ConversationID, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id FROM conversations
		 WHERE workspace_id = ? AND parent_conversation_id = ''
		 ORDER BY created_at ASC`, string(wsID))
	if err != nil {
		return nil, fmt.Errorf("load conversation roots: %w", err)
	}
	defer rows.Close()

	var ids []models.ConversationID
	for rows.Next() {
		var id models.ConversationID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan conversation id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// marshalJSON is a helper that marshals to JSON, returning "[]" / "{}" for nil
// slices/maps as appropriate defaults.
func marshalJSON(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
