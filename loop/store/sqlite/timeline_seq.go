package sqlite

import (
	"context"
	"database/sql"
	"fmt"
)

func nextTimelineSeqTx(ctx context.Context, tx *sql.Tx, convID string) (int64, error) {
	var next int64
	err := tx.QueryRowContext(ctx,
		`SELECT next_timeline_seq FROM conversation_timeline_cursors WHERE conversation_id = ?`,
		convID,
	).Scan(&next)
	if err == nil {
		if _, err := tx.ExecContext(ctx,
			`UPDATE conversation_timeline_cursors SET next_timeline_seq = ? WHERE conversation_id = ?`,
			next+1, convID,
		); err != nil {
			return 0, fmt.Errorf("update timeline cursor: %w", err)
		}
		return next, nil
	}
	if err != sql.ErrNoRows {
		return 0, fmt.Errorf("load timeline cursor: %w", err)
	}

	// Fallback for conversations created before cursor initialization.
	var maxSeq int64
	if err := tx.QueryRowContext(ctx, `
		SELECT MAX(v) FROM (
			SELECT COALESCE(MAX(timeline_seq), 0) AS v FROM messages WHERE conversation_id = ?
			UNION ALL
			SELECT COALESCE(MAX(timeline_seq), 0) AS v FROM ui_events WHERE conversation_id = ?
		)
	`, convID, convID).Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("compute max timeline seq: %w", err)
	}
	next = maxSeq + 1

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO conversation_timeline_cursors(conversation_id, next_timeline_seq)
		VALUES (?, ?)
	`, convID, next+1); err != nil {
		return 0, fmt.Errorf("insert timeline cursor: %w", err)
	}
	return next, nil
}
