package db

import (
	"database/sql"
	"fmt"

	"bench/internal/model"
)

// FindingSummary returns aggregate counts grouped by severity and status.
func (d *DB) FindingSummary() ([]model.FindingSummaryRow, error) {
	rows, err := d.conn.Query(`
		SELECT severity, status, COUNT(*) as count
		FROM findings
		WHERE project_id = ?
		GROUP BY severity, status
		ORDER BY
			CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'info' THEN 5 END,
			status`, d.projectID)
	if err != nil {
		return nil, fmt.Errorf("query finding summary: %w", err)
	}
	defer rows.Close()

	var results []model.FindingSummaryRow
	for rows.Next() {
		var r model.FindingSummaryRow
		if err := rows.Scan(&r.Severity, &r.Status, &r.Count); err != nil {
			return nil, fmt.Errorf("scan finding summary: %w", err)
		}
		results = append(results, r)
	}
	return results, rows.Err()
}

// UnresolvedCommentCount returns the number of comments with no resolved_commit.
func (d *DB) UnresolvedCommentCount() (int, error) {
	var count int
	err := d.conn.QueryRow(`SELECT COUNT(*) FROM comments WHERE project_id = ? AND resolved_commit IS NULL`, d.projectID).Scan(&count)
	return count, err
}

// FindingCategorySummary returns aggregate counts grouped by category.
func (d *DB) FindingCategorySummary() (map[string]int, error) {
	rows, err := d.conn.Query(
		`SELECT category, COUNT(*) FROM findings WHERE project_id = ? AND category != '' GROUP BY category`,
		d.projectID)
	if err != nil {
		return nil, fmt.Errorf("query finding category summary: %w", err)
	}
	defer rows.Close()

	result := make(map[string]int)
	for rows.Next() {
		var cat string
		var count int
		if err := rows.Scan(&cat, &count); err != nil {
			return nil, fmt.Errorf("scan finding category summary: %w", err)
		}
		result[cat] = count
	}
	return result, rows.Err()
}

// SearchFindings searches findings by title/description text with optional status/severity filters.
func (d *DB) SearchFindings(query, status, severity string, limit int) ([]model.Finding, error) {
	if limit <= 0 {
		limit = 50
	}

	q := `SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
		severity, title, description, cwe, cve, vector, score, status, source, category, created_at, resolved_commit, line_hash
		FROM findings
		WHERE project_id = ?1 AND (title LIKE '%' || ?2 || '%' OR description LIKE '%' || ?2 || '%')`

	args := []any{d.projectID, query}
	argIdx := 3
	if status != "" {
		q += fmt.Sprintf(` AND status = ?%d`, argIdx)
		args = append(args, status)
		argIdx++
	}
	if severity != "" {
		q += fmt.Sprintf(` AND severity = ?%d`, argIdx)
		args = append(args, severity)
		argIdx++
	}
	q += fmt.Sprintf(` ORDER BY created_at DESC LIMIT ?%d`, argIdx)
	args = append(args, limit)

	return d.queryFindings(q, args...)
}

// queryFindings is a helper that scans finding rows from a query.
func (d *DB) queryFindings(query string, args ...any) ([]model.Finding, error) {
	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query findings: %w", err)
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
			&f.Status, &f.Source, &f.Category, &f.CreatedAt, &resolvedCommit, &f.LineHash)
		if err != nil {
			return nil, fmt.Errorf("scan finding: %w", err)
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
	return findings, rows.Err()
}
