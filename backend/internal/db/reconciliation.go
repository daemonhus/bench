package db

import (
	"database/sql"
)

// GetReconciliationState returns the last reconciled commit ID for a file.
// Returns empty string if no reconciliation has been done for this file.
func (d *DB) GetReconciliationState(fileID string) (string, error) {
	var commitID string
	err := d.conn.QueryRow(
		`SELECT last_commit_id FROM reconciliation_log WHERE file_id = ? AND project_id = ?`,
		fileID, d.projectID,
	).Scan(&commitID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return commitID, err
}

// SetReconciliationState records that a file has been reconciled through
// the given commit. Uses INSERT OR REPLACE to upsert.
func (d *DB) SetReconciliationState(fileID, commitID string) error {
	_, err := d.conn.Exec(
		`INSERT OR REPLACE INTO reconciliation_log (project_id, file_id, last_commit_id, updated_at)
		VALUES (?, ?, ?, datetime('now'))`,
		d.projectID, fileID, commitID,
	)
	return err
}

// ListAnnotatedFiles returns all unique file IDs that have at least one
// finding, comment, or feature anchored to them.
func (d *DB) ListAnnotatedFiles() ([]string, error) {
	rows, err := d.conn.Query(
		`SELECT DISTINCT anchor_file_id FROM (
			SELECT anchor_file_id FROM findings WHERE project_id = ?
			UNION
			SELECT anchor_file_id FROM comments WHERE project_id = ?
			UNION
			SELECT anchor_file_id FROM features WHERE project_id = ?
		) WHERE anchor_file_id != '' AND anchor_file_id IS NOT NULL`,
		d.projectID, d.projectID, d.projectID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}
