package db

import (
	"fmt"

	"bench/internal/model"
)

// MarkReviewed upserts a review progress entry.
func (d *DB) MarkReviewed(fileID, commitID, reviewer, note string) error {
	_, err := d.conn.Exec(
		`INSERT INTO review_progress (project_id, file_id, commit_id, reviewer, note, reviewed_at)
		VALUES (?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(project_id, file_id, reviewer) DO UPDATE SET
			commit_id = excluded.commit_id,
			note = excluded.note,
			reviewed_at = excluded.reviewed_at`,
		d.projectID, fileID, commitID, reviewer, note,
	)
	return err
}

// GetReviewProgress returns all review progress entries, optionally filtered by file prefix.
func (d *DB) GetReviewProgress(prefix string) ([]model.ReviewProgress, error) {
	filter := "%"
	if prefix != "" {
		filter = prefix + "%"
	}
	rows, err := d.conn.Query(
		`SELECT file_id, commit_id, reviewer, note, reviewed_at
		FROM review_progress
		WHERE project_id = ? AND file_id LIKE ?
		ORDER BY file_id`,
		d.projectID, filter,
	)
	if err != nil {
		return nil, fmt.Errorf("query review_progress: %w", err)
	}
	defer rows.Close()

	var results []model.ReviewProgress
	for rows.Next() {
		var rp model.ReviewProgress
		if err := rows.Scan(&rp.FileID, &rp.CommitID, &rp.Reviewer, &rp.Note, &rp.ReviewedAt); err != nil {
			return nil, fmt.Errorf("scan review_progress: %w", err)
		}
		results = append(results, rp)
	}
	return results, rows.Err()
}
