package db

import (
	"database/sql"
	"fmt"
	"strings"

	"bench/internal/model"
)

func (d *DB) ListComments(fileID, findingID string, limit, offset int, featureID ...string) ([]model.Comment, int, error) {
	conditions := []string{`project_id = ?`}
	whereArgs := []any{d.projectID}
	if fileID != "" {
		conditions = append(conditions, `anchor_file_id = ?`)
		whereArgs = append(whereArgs, fileID)
	}
	if findingID != "" {
		conditions = append(conditions, `finding_id = ?`)
		whereArgs = append(whereArgs, findingID)
	}
	if len(featureID) > 0 && featureID[0] != "" {
		conditions = append(conditions, `feature_id = ?`)
		whereArgs = append(whereArgs, featureID[0])
	}
	baseWhere := ` WHERE ` + strings.Join(conditions, ` AND `)

	// Count total matching rows when paginating
	total := 0
	if limit > 0 {
		countQuery := `SELECT COUNT(*) FROM comments` + baseWhere
		if err := d.conn.QueryRow(countQuery, whereArgs...).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("count comments: %w", err)
		}
	}

	query := `SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
		author, text, comment_type, timestamp, thread_id, parent_id, finding_id, feature_id, resolved_commit, line_hash, anchor_updated_at FROM comments` + baseWhere
	query += ` ORDER BY timestamp ASC`
	args := append([]any{}, whereArgs...)
	if limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	}

	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query comments: %w", err)
	}
	defer rows.Close()

	var comments []model.Comment
	for rows.Next() {
		var c model.Comment
		var lineStart, lineEnd sql.NullInt64
		var parentID, findingIDVal, featureIDVal, resolvedCommit, anchorUpdatedAt sql.NullString
		err := rows.Scan(&c.ID, &c.Anchor.FileID, &c.Anchor.CommitID,
			&lineStart, &lineEnd,
			&c.Author, &c.Text, &c.CommentType, &c.Timestamp, &c.ThreadID, &parentID, &findingIDVal, &featureIDVal, &resolvedCommit, &c.LineHash, &anchorUpdatedAt)
		if err != nil {
			return nil, 0, fmt.Errorf("scan comment: %w", err)
		}
		if lineStart.Valid && lineEnd.Valid {
			c.Anchor.LineRange = &model.LineRange{
				Start: int(lineStart.Int64),
				End:   int(lineEnd.Int64),
			}
		}
		if parentID.Valid {
			c.ParentID = &parentID.String
		}
		if findingIDVal.Valid {
			c.FindingID = &findingIDVal.String
		}
		if featureIDVal.Valid {
			c.FeatureID = &featureIDVal.String
		}
		if resolvedCommit.Valid {
			c.ResolvedCommit = &resolvedCommit.String
		}
		if anchorUpdatedAt.Valid {
			c.AnchorUpdatedAt = &anchorUpdatedAt.String
		}
		comments = append(comments, c)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if limit == 0 {
		total = len(comments)
	}
	return comments, total, nil
}

func (d *DB) CreateComment(c *model.Comment) error {
	var lineStart, lineEnd *int
	if c.Anchor.LineRange != nil {
		lineStart = &c.Anchor.LineRange.Start
		lineEnd = &c.Anchor.LineRange.End
	}
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT INTO comments (project_id, id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			author, text, comment_type, timestamp, thread_id, parent_id, finding_id, feature_id, resolved_commit, line_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			d.projectID, c.ID, c.Anchor.FileID, c.Anchor.CommitID, lineStart, lineEnd,
			c.Author, c.Text, c.CommentType, c.Timestamp, c.ThreadID, c.ParentID, c.FindingID, c.FeatureID, c.ResolvedCommit, c.LineHash,
		)
		return err
	})
}

func (d *DB) GetComment(id string) (*model.Comment, error) {
	var c model.Comment
	var lineStart, lineEnd sql.NullInt64
	var parentID, findingID, featureID, resolvedCommit, anchorUpdatedAt sql.NullString
	err := d.conn.QueryRow(
		`SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			author, text, comment_type, timestamp, thread_id, parent_id, finding_id, feature_id, resolved_commit, line_hash, anchor_updated_at
		FROM comments WHERE id = ? AND project_id = ?`, id, d.projectID,
	).Scan(&c.ID, &c.Anchor.FileID, &c.Anchor.CommitID,
		&lineStart, &lineEnd,
		&c.Author, &c.Text, &c.CommentType, &c.Timestamp, &c.ThreadID, &parentID, &findingID, &featureID, &resolvedCommit, &c.LineHash, &anchorUpdatedAt)
	if err != nil {
		return nil, err
	}
	if lineStart.Valid && lineEnd.Valid {
		c.Anchor.LineRange = &model.LineRange{
			Start: int(lineStart.Int64),
			End:   int(lineEnd.Int64),
		}
	}
	if parentID.Valid {
		c.ParentID = &parentID.String
	}
	if findingID.Valid {
		c.FindingID = &findingID.String
	}
	if featureID.Valid {
		c.FeatureID = &featureID.String
	}
	if resolvedCommit.Valid {
		c.ResolvedCommit = &resolvedCommit.String
	}
	if anchorUpdatedAt.Valid {
		c.AnchorUpdatedAt = &anchorUpdatedAt.String
	}
	return &c, nil
}

func (d *DB) UpdateComment(id string, updates map[string]any) error {
	allowed := map[string]string{
		"text":           "text",
		"author":         "author",
		"commentType":    "comment_type",
		"comment_type":   "comment_type",
		"resolvedCommit": "resolved_commit",
		"file":           "anchor_file_id",
		"file_id":        "anchor_file_id",
		"commit":         "anchor_commit_id",
		"commit_id":      "anchor_commit_id",
		"line_start":     "anchor_line_start",
		"line_end":       "anchor_line_end",
		"featureId":         "feature_id",
		"feature_id":        "feature_id",
		"line_hash":         "line_hash",
		"anchor_updated_at": "anchor_updated_at",
	}
	var setClauses []string
	var args []any
	for jsonKey, col := range allowed {
		if v, ok := updates[jsonKey]; ok {
			setClauses = append(setClauses, col+" = ?")
			args = append(args, v)
		}
	}
	if len(setClauses) == 0 {
		return fmt.Errorf("no valid fields to update")
	}
	args = append(args, id, d.projectID)
	query := "UPDATE comments SET " + strings.Join(setClauses, ", ") + " WHERE id = ? AND project_id = ?"
	return wq0(d.wq, func() error {
		res, err := d.conn.Exec(query, args...)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("comment not found: %s", id)
		}
		return nil
	})
}

// BatchCreateComments inserts multiple comments in a single transaction.
// Returns the IDs of created comments. All-or-nothing — rolls back on any error.
func (d *DB) BatchCreateComments(comments []model.Comment) ([]string, error) {
	return wq(d.wq, func() ([]string, error) {
		tx, err := d.conn.Begin()
		if err != nil {
			return nil, fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		stmt, err := tx.Prepare(
			`INSERT INTO comments (project_id, id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			author, text, comment_type, timestamp, thread_id, parent_id, finding_id, feature_id, resolved_commit, line_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		if err != nil {
			return nil, fmt.Errorf("prepare: %w", err)
		}
		defer stmt.Close()

		ids := make([]string, 0, len(comments))
		for i := range comments {
			c := &comments[i]
			var lineStart, lineEnd *int
			if c.Anchor.LineRange != nil {
				lineStart = &c.Anchor.LineRange.Start
				lineEnd = &c.Anchor.LineRange.End
			}
			_, err := stmt.Exec(
				d.projectID, c.ID, c.Anchor.FileID, c.Anchor.CommitID, lineStart, lineEnd,
				c.Author, c.Text, c.CommentType, c.Timestamp, c.ThreadID, c.ParentID, c.FindingID, c.FeatureID, c.ResolvedCommit, c.LineHash,
			)
			if err != nil {
				return nil, fmt.Errorf("insert comment %d (%s): %w", i, c.ID, err)
			}
			ids = append(ids, c.ID)
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit: %w", err)
		}
		return ids, nil
	})
}

func (d *DB) DeleteComment(id string) error {
	return wq0(d.wq, func() error {
		res, err := d.conn.Exec(`DELETE FROM comments WHERE id = ? AND project_id = ?`, id, d.projectID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("comment not found: %s", id)
		}
		return nil
	})
}

// CommentCountsByFinding returns a map of findingID → comment count.
func (d *DB) CommentCountsByFinding(findingIDs []string) (map[string]int, error) {
	if len(findingIDs) == 0 {
		return map[string]int{}, nil
	}
	placeholders := make([]string, len(findingIDs))
	args := make([]any, 0, len(findingIDs)+1)
	args = append(args, d.projectID)
	for i, id := range findingIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	query := `SELECT finding_id, COUNT(*) FROM comments WHERE project_id = ? AND finding_id IN (` + strings.Join(placeholders, ",") + `) GROUP BY finding_id`
	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("comment counts: %w", err)
	}
	defer rows.Close()
	counts := make(map[string]int)
	for rows.Next() {
		var fid string
		var count int
		if err := rows.Scan(&fid, &count); err != nil {
			return nil, err
		}
		counts[fid] = count
	}
	return counts, rows.Err()
}
