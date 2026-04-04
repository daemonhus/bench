package db

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"bench/internal/model"
)

func (d *DB) ListFeatures(fileID string, limit, offset int) ([]model.Feature, int, error) {
	baseWhere := ` WHERE project_id = ?`
	whereArgs := []any{d.projectID}
	if fileID != "" {
		baseWhere += ` AND anchor_file_id = ?`
		whereArgs = append(whereArgs, fileID)
	}

	total := 0
	if limit > 0 {
		countQuery := `SELECT COUNT(*) FROM features` + baseWhere
		if err := d.conn.QueryRow(countQuery, whereArgs...).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("count features: %w", err)
		}
	}

	query := `SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
		kind, title, description, operation, direction, protocol, status, tags, source, created_at, resolved_commit, line_hash, anchor_updated_at FROM features` + baseWhere
	query += ` ORDER BY created_at DESC`
	args := append([]any{}, whereArgs...)
	if limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	}

	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query features: %w", err)
	}
	defer rows.Close()

	var features []model.Feature
	for rows.Next() {
		f, err := scanFeatureRow(rows)
		if err != nil {
			return nil, 0, err
		}
		features = append(features, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if limit == 0 {
		total = len(features)
	}
	return features, total, nil
}

func (d *DB) GetFeature(id string) (*model.Feature, error) {
	rows, err := d.conn.Query(
		`SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			kind, title, description, operation, direction, protocol, status, tags, source, created_at, resolved_commit, line_hash, anchor_updated_at
		FROM features WHERE id = ? AND project_id = ?`, id, d.projectID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, fmt.Errorf("feature not found: %s", id)
	}
	return scanFeatureRow(rows)
}

func scanFeatureRow(rows *sql.Rows) (*model.Feature, error) {
	var f model.Feature
	var lineStart, lineEnd sql.NullInt64
	var resolvedCommit, anchorUpdatedAt sql.NullString
	var tagsJSON string
	err := rows.Scan(&f.ID, &f.Anchor.FileID, &f.Anchor.CommitID,
		&lineStart, &lineEnd,
		&f.Kind, &f.Title, &f.Description, &f.Operation, &f.Direction, &f.Protocol,
		&f.Status, &tagsJSON, &f.Source, &f.CreatedAt, &resolvedCommit, &f.LineHash, &anchorUpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("scan feature: %w", err)
	}
	if lineStart.Valid && lineEnd.Valid {
		f.Anchor.LineRange = &model.LineRange{
			Start: int(lineStart.Int64),
			End:   int(lineEnd.Int64),
		}
	}
	if resolvedCommit.Valid {
		f.ResolvedCommit = &resolvedCommit.String
	}
	if anchorUpdatedAt.Valid {
		f.AnchorUpdatedAt = &anchorUpdatedAt.String
	}
	if err := json.Unmarshal([]byte(tagsJSON), &f.Tags); err != nil {
		f.Tags = []string{}
	}
	return &f, nil
}

func (d *DB) CreateFeature(f *model.Feature) error {
	var lineStart, lineEnd *int
	if f.Anchor.LineRange != nil {
		lineStart = &f.Anchor.LineRange.Start
		lineEnd = &f.Anchor.LineRange.End
	}
	tagsJSON, _ := json.Marshal(f.Tags)
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT INTO features (project_id, id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			kind, title, description, operation, direction, protocol, status, tags, source, created_at, resolved_commit, line_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			d.projectID, f.ID, f.Anchor.FileID, f.Anchor.CommitID, lineStart, lineEnd,
			f.Kind, f.Title, f.Description, f.Operation, f.Direction, f.Protocol,
			f.Status, string(tagsJSON), f.Source, f.CreatedAt, f.ResolvedCommit, f.LineHash,
		)
		return err
	})
}

func (d *DB) UpdateFeature(id string, updates map[string]any) (*model.Feature, error) {
	allowed := map[string]string{
		"kind":            "kind",
		"title":           "title",
		"description":     "description",
		"operation":       "operation",
		"direction":       "direction",
		"protocol":        "protocol",
		"status":          "status",
		"source":          "source",
		"file":            "anchor_file_id",
		"file_id":         "anchor_file_id",
		"commit":          "anchor_commit_id",
		"commit_id":       "anchor_commit_id",
		"line_start":      "anchor_line_start",
		"line_end":        "anchor_line_end",
		"line_hash":       "line_hash",
		"resolved_commit": "resolved_commit",
		"resolvedCommit":    "resolved_commit",
		"anchor_updated_at": "anchor_updated_at",
	}

	// Handle tags specially (needs JSON serialization)
	var tagsClauses []string
	var tagsArgs []any
	if tagsVal, ok := updates["tags"]; ok {
		tagsJSON, _ := json.Marshal(tagsVal)
		tagsClauses = append(tagsClauses, "tags = ?")
		tagsArgs = append(tagsArgs, string(tagsJSON))
		delete(updates, "tags")
	}

	var setClauses []string
	var args []any
	for jsonKey, col := range allowed {
		if v, ok := updates[jsonKey]; ok {
			setClauses = append(setClauses, col+" = ?")
			args = append(args, v)
		}
	}
	setClauses = append(setClauses, tagsClauses...)
	args = append(args, tagsArgs...)

	if len(setClauses) == 0 {
		return nil, fmt.Errorf("no valid fields to update")
	}

	args = append(args, id, d.projectID)
	query := "UPDATE features SET "
	for i, c := range setClauses {
		if i > 0 {
			query += ", "
		}
		query += c
	}
	query += " WHERE id = ? AND project_id = ?"

	err := wq0(d.wq, func() error {
		res, err := d.conn.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("update feature: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("feature not found: %s", id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return d.GetFeature(id)
}

func (d *DB) DeleteFeature(id string) error {
	return wq0(d.wq, func() error {
		tx, err := d.conn.Begin()
		if err != nil {
			return fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		res, err := tx.Exec(`DELETE FROM features WHERE id = ? AND project_id = ?`, id, d.projectID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("feature not found: %s", id)
		}

		if _, err := tx.Exec(`DELETE FROM finding_features WHERE feature_id = ? AND project_id = ?`, id, d.projectID); err != nil {
			return fmt.Errorf("delete finding_features: %w", err)
		}

		return tx.Commit()
	})
}

func (d *DB) BatchCreateFeatures(features []model.Feature) ([]string, error) {
	return wq(d.wq, func() ([]string, error) {
		tx, err := d.conn.Begin()
		if err != nil {
			return nil, fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		stmt, err := tx.Prepare(
			`INSERT INTO features (project_id, id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			kind, title, description, operation, direction, protocol, status, tags, source, created_at, resolved_commit, line_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		if err != nil {
			return nil, fmt.Errorf("prepare: %w", err)
		}
		defer stmt.Close()

		ids := make([]string, 0, len(features))
		for i := range features {
			f := &features[i]
			var lineStart, lineEnd *int
			if f.Anchor.LineRange != nil {
				lineStart = &f.Anchor.LineRange.Start
				lineEnd = &f.Anchor.LineRange.End
			}
			tagsJSON, _ := json.Marshal(f.Tags)
			_, err := stmt.Exec(
				d.projectID, f.ID, f.Anchor.FileID, f.Anchor.CommitID, lineStart, lineEnd,
				f.Kind, f.Title, f.Description, f.Operation, f.Direction, f.Protocol,
				f.Status, string(tagsJSON), f.Source, f.CreatedAt, f.ResolvedCommit, f.LineHash,
			)
			if err != nil {
				return nil, fmt.Errorf("insert feature %d (%s): %w", i, f.ID, err)
			}
			ids = append(ids, f.ID)
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit: %w", err)
		}
		return ids, nil
	})
}

// BatchOrphanFeatures sets status='orphaned' and resolved_commit for multiple features.
func (d *DB) BatchOrphanFeatures(ids []string, orphanCommit string) error {
	if len(ids) == 0 {
		return nil
	}
	return wq0(d.wq, func() error {
		tx, err := d.conn.Begin()
		if err != nil {
			return fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		stmt, err := tx.Prepare(`UPDATE features SET status = 'orphaned', resolved_commit = ? WHERE id = ? AND project_id = ?`)
		if err != nil {
			return fmt.Errorf("prepare: %w", err)
		}
		defer stmt.Close()

		for _, id := range ids {
			if _, err := stmt.Exec(orphanCommit, id, d.projectID); err != nil {
				return fmt.Errorf("orphan feature %s: %w", id, err)
			}
		}

		return tx.Commit()
	})
}

// AllFeatureIDs returns all feature IDs for the project.
func (d *DB) AllFeatureIDs() ([]string, error) {
	rows, err := d.conn.Query(
		`SELECT id FROM features WHERE project_id = ? ORDER BY created_at`,
		d.projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list feature ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan feature id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// FeatureKindSummary returns counts by kind for all features.
func (d *DB) FeatureKindSummary() (map[string]int, error) {
	rows, err := d.conn.Query(
		`SELECT kind, COUNT(*) FROM features WHERE project_id = ? GROUP BY kind`,
		d.projectID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int)
	for rows.Next() {
		var kind string
		var count int
		if err := rows.Scan(&kind, &count); err != nil {
			return nil, err
		}
		result[kind] = count
	}
	return result, rows.Err()
}
