package db

import (
	"database/sql"
	"fmt"

	"bench/internal/model"
)

func (d *DB) ListFindings(fileID string, limit, offset int) ([]model.Finding, int, error) {
	baseWhere := ` WHERE project_id = ?`
	whereArgs := []any{d.projectID}
	if fileID != "" {
		baseWhere += ` AND anchor_file_id = ?`
		whereArgs = append(whereArgs, fileID)
	}

	// Count total matching rows when paginating
	total := 0
	if limit > 0 {
		countQuery := `SELECT COUNT(*) FROM findings` + baseWhere
		if err := d.conn.QueryRow(countQuery, whereArgs...).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("count findings: %w", err)
		}
	}

	query := `SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
		severity, title, description, cwe, cve, vector, score, status, source, category, created_at, resolved_commit, line_hash, external_id FROM findings` + baseWhere
	query += ` ORDER BY created_at DESC`
	args := append([]any{}, whereArgs...)
	if limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	}

	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query findings: %w", err)
	}
	defer rows.Close()

	var findings []model.Finding
	for rows.Next() {
		var f model.Finding
		var lineStart, lineEnd sql.NullInt64
		var resolvedCommit sql.NullString
		err := rows.Scan(&f.ID, &f.Anchor.FileID, &f.Anchor.CommitID,
			&lineStart, &lineEnd,
			&f.Severity, &f.Title, &f.Description, &f.CWE, &f.CVE, &f.Vector, &f.Score,
			&f.Status, &f.Source, &f.Category, &f.CreatedAt, &resolvedCommit, &f.LineHash, &f.ExternalID)
		if err != nil {
			return nil, 0, fmt.Errorf("scan finding: %w", err)
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
		findings = append(findings, f)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if limit == 0 {
		total = len(findings)
	}
	return findings, total, nil
}

func (d *DB) CreateFinding(f *model.Finding) error {
	var lineStart, lineEnd *int
	if f.Anchor.LineRange != nil {
		lineStart = &f.Anchor.LineRange.Start
		lineEnd = &f.Anchor.LineRange.End
	}
	_, err := d.conn.Exec(
		`INSERT INTO findings (project_id, id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			severity, title, description, cwe, cve, vector, score, status, source, category, created_at, resolved_commit, line_hash, external_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.projectID, f.ID, f.Anchor.FileID, f.Anchor.CommitID, lineStart, lineEnd,
		f.Severity, f.Title, f.Description, f.CWE, f.CVE, f.Vector, f.Score,
		f.Status, f.Source, f.Category, f.CreatedAt, f.ResolvedCommit, f.LineHash, f.ExternalID,
	)
	return err
}

func (d *DB) UpdateFinding(id string, updates map[string]any) (*model.Finding, error) {
	allowed := map[string]string{
		"severity":       "severity",
		"title":          "title",
		"description":    "description",
		"cwe":            "cwe",
		"cve":            "cve",
		"vector":         "vector",
		"score":          "score",
		"status":         "status",
		"source":         "source",
		"resolvedCommit": "resolved_commit",
		"externalId":     "external_id",
		"external_id":    "external_id",
		"category":       "category",
		"file_id":        "anchor_file_id",
		"commit_id":      "anchor_commit_id",
		"line_start":     "anchor_line_start",
		"line_end":       "anchor_line_end",
		"line_hash":      "line_hash",
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
		return nil, fmt.Errorf("no valid fields to update")
	}

	args = append(args, id, d.projectID)
	query := "UPDATE findings SET "
	for i, c := range setClauses {
		if i > 0 {
			query += ", "
		}
		query += c
	}
	query += " WHERE id = ? AND project_id = ?"

	res, err := d.conn.Exec(query, args...)
	if err != nil {
		return nil, fmt.Errorf("update finding: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, fmt.Errorf("finding not found: %s", id)
	}

	return d.GetFinding(id)
}

func (d *DB) GetFinding(id string) (*model.Finding, error) {
	var f model.Finding
	var lineStart, lineEnd sql.NullInt64
	var resolvedCommit sql.NullString
	err := d.conn.QueryRow(
		`SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			severity, title, description, cwe, cve, vector, score, status, source, category, created_at, resolved_commit, line_hash, external_id
		FROM findings WHERE id = ? AND project_id = ?`, id, d.projectID,
	).Scan(&f.ID, &f.Anchor.FileID, &f.Anchor.CommitID,
		&lineStart, &lineEnd,
		&f.Severity, &f.Title, &f.Description, &f.CWE, &f.CVE, &f.Vector, &f.Score,
		&f.Status, &f.Source, &f.Category, &f.CreatedAt, &resolvedCommit, &f.LineHash, &f.ExternalID)
	if err != nil {
		return nil, err
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
	return &f, nil
}

// BatchCreateFindings inserts multiple findings in a single transaction.
// Returns the IDs of created findings. All-or-nothing — rolls back on any error.
func (d *DB) BatchCreateFindings(findings []model.Finding) ([]string, error) {
	tx, err := d.conn.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(
		`INSERT INTO findings (project_id, id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			severity, title, description, cwe, cve, vector, score, status, source, category, created_at, resolved_commit, line_hash, external_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return nil, fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	ids := make([]string, 0, len(findings))
	for i := range findings {
		f := &findings[i]
		var lineStart, lineEnd *int
		if f.Anchor.LineRange != nil {
			lineStart = &f.Anchor.LineRange.Start
			lineEnd = &f.Anchor.LineRange.End
		}
		_, err := stmt.Exec(
			d.projectID, f.ID, f.Anchor.FileID, f.Anchor.CommitID, lineStart, lineEnd,
			f.Severity, f.Title, f.Description, f.CWE, f.CVE, f.Vector, f.Score,
			f.Status, f.Source, f.Category, f.CreatedAt, f.ResolvedCommit, f.LineHash, f.ExternalID,
		)
		if err != nil {
			return nil, fmt.Errorf("insert finding %d (%s): %w", i, f.ID, err)
		}
		ids = append(ids, f.ID)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return ids, nil
}

// BatchResolveFindings sets resolved_commit and status='closed' for multiple
// findings in a single transaction. Returns the number of findings updated.
func (d *DB) BatchResolveFindings(items []struct{ ID, Commit string }) (int, error) {
	tx, err := d.conn.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`UPDATE findings SET resolved_commit = ?, status = 'closed' WHERE id = ? AND project_id = ?`)
	if err != nil {
		return 0, fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	count := 0
	for _, item := range items {
		res, err := stmt.Exec(item.Commit, item.ID, d.projectID)
		if err != nil {
			return 0, fmt.Errorf("resolve finding %s: %w", item.ID, err)
		}
		n, _ := res.RowsAffected()
		count += int(n)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return count, nil
}

func (d *DB) DeleteFinding(id string) error {
	tx, err := d.conn.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Nullify finding_id on linked comments so they survive as standalone
	if _, err := tx.Exec(`UPDATE comments SET finding_id = NULL WHERE finding_id = ? AND project_id = ?`, id, d.projectID); err != nil {
		return fmt.Errorf("nullify comments: %w", err)
	}

	res, err := tx.Exec(`DELETE FROM findings WHERE id = ? AND project_id = ?`, id, d.projectID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("finding not found: %s", id)
	}
	return tx.Commit()
}
