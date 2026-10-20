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
	ids := make([]string, len(comments))
	for i, c := range comments {
		ids[i] = c.ID
	}
	if refsMap, err := d.enrichWithRefs("comment", ids); err == nil && refsMap != nil {
		for i, c := range comments {
			comments[i].Refs = refsMap[c.ID]
		}
	}
	return comments, total, nil
}

// rowQuerier is what threadReply reads with: the connection, or the batch's transaction
// (so a reply can follow a parent created earlier in the same batch).
type rowQuerier interface {
	QueryRow(query string, args ...any) *sql.Row
}

// threadReply places a comment in its thread before it is stored. A reply joins its
// parent's thread and, unless it names its own, the parent's finding and feature; a
// parent that doesn't exist is refused rather than leaving the reply in a thread of its
// own. A top-level comment without a thread starts one, named by its own ID.
func (d *DB) threadReply(q rowQuerier, c *model.Comment) error {
	if c.ParentID == nil || *c.ParentID == "" {
		if c.ThreadID == "" {
			c.ThreadID = c.ID
		}
		return nil
	}
	var thread, finding, feature sql.NullString
	err := q.QueryRow(`SELECT thread_id, finding_id, feature_id FROM comments WHERE id = ? AND project_id = ?`,
		*c.ParentID, d.projectID).Scan(&thread, &finding, &feature)
	if err == sql.ErrNoRows {
		return fmt.Errorf("%w: %q", model.ErrUnknownParent, *c.ParentID)
	}
	if err != nil {
		return fmt.Errorf("look up parent comment: %w", err)
	}
	c.ThreadID = thread.String
	if c.ThreadID == "" { // a parent stored before threads were always set roots its own
		c.ThreadID = *c.ParentID
	}
	if (c.FindingID == nil || *c.FindingID == "") && finding.Valid && finding.String != "" {
		v := finding.String
		c.FindingID = &v
	}
	if (c.FeatureID == nil || *c.FeatureID == "") && feature.Valid && feature.String != "" {
		v := feature.String
		c.FeatureID = &v
	}
	return nil
}

func (d *DB) CreateComment(c *model.Comment) error {
	if err := d.checkAnchors(&c.Anchor); err != nil {
		return err
	}
	var lineStart, lineEnd *int
	if c.Anchor.LineRange != nil {
		lineStart = &c.Anchor.LineRange.Start
		lineEnd = &c.Anchor.LineRange.End
	}
	return wq0(d.wq, func() error {
		if err := d.threadReply(d.conn, c); err != nil {
			return err
		}
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
	id, err := d.resolveID("comments", id)
	if err != nil {
		return nil, err
	}
	var c model.Comment
	var lineStart, lineEnd sql.NullInt64
	var parentID, findingID, featureID, resolvedCommit, anchorUpdatedAt sql.NullString
	err = d.conn.QueryRow(
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
	id, err := d.resolveID("comments", id)
	if err != nil {
		return err
	}
	if err := d.mergeLineRangeUpdate("comments", id, updates); err != nil {
		return err
	}
	d.pinCommitUpdate(updates)
	allowed := map[string]string{
		"text":              "text",
		"author":            "author",
		"commentType":       "comment_type",
		"comment_type":      "comment_type",
		"resolvedCommit":    "resolved_commit",
		"file":              "anchor_file_id",
		"file_id":           "anchor_file_id",
		"commit":            "anchor_commit_id",
		"commit_id":         "anchor_commit_id",
		"line_start":        "anchor_line_start",
		"line_end":          "anchor_line_end",
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
// Returns the IDs of created comments. All-or-nothing - rolls back on any error.
func (d *DB) BatchCreateComments(comments []model.Comment) ([]string, error) {
	anchors := make([]*model.Anchor, len(comments))
	for i := range comments {
		anchors[i] = &comments[i].Anchor
	}
	if err := d.checkAnchors(anchors...); err != nil {
		return nil, err
	}
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
			if err := d.threadReply(tx, c); err != nil {
				return nil, fmt.Errorf("comment %d: %w", i, err)
			}
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
	id, err := d.resolveID("comments", id)
	if err != nil {
		return err
	}
	return wq0(d.wq, func() error {
		tx, err := d.conn.Begin()
		if err != nil {
			return fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		if _, err := tx.Exec(`DELETE FROM refs WHERE entity_type = 'comment' AND entity_id = ? AND project_id = ?`, id, d.projectID); err != nil {
			return fmt.Errorf("delete refs: %w", err)
		}
		res, err := tx.Exec(`DELETE FROM comments WHERE id = ? AND project_id = ?`, id, d.projectID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("comment not found: %s", id)
		}
		return tx.Commit()
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
