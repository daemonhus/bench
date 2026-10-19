package db

import (
	"fmt"
	"strings"

	"bench/internal/model"
)

// MarkReviewed upserts a review progress entry.
func (d *DB) MarkReviewed(fileID, commitID, reviewer, note string) error {
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT INTO review_progress (project_id, file_id, commit_id, reviewer, note, reviewed_at)
		VALUES (?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(project_id, file_id, reviewer) DO UPDATE SET
			commit_id = excluded.commit_id,
			note = excluded.note,
			reviewed_at = excluded.reviewed_at`,
			d.projectID, strings.Trim(fileID, "/"), commitID, reviewer, note,
		)
		return err
	})
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

// ReviewLookup answers "was this file reviewed, and when?" from review
// progress entries. mark-reviewed accepts a directory as well as a file, so a
// file counts as reviewed when it, or any directory above it, was marked.
// When several entries cover a file (different reviewers, or a file mark and
// a directory mark) the most recent one wins.
type ReviewLookup map[string]model.ReviewProgress

// NewReviewLookup indexes progress entries by their (slash-trimmed) path.
func NewReviewLookup(progress []model.ReviewProgress) ReviewLookup {
	l := ReviewLookup{}
	for _, rp := range progress {
		key := strings.Trim(rp.FileID, "/")
		if prev, ok := l[key]; !ok || rp.ReviewedAt > prev.ReviewedAt {
			l[key] = rp
		}
	}
	return l
}

// For returns the review entry that covers path, if any.
func (l ReviewLookup) For(path string) (model.ReviewProgress, bool) {
	var best model.ReviewProgress
	found := false
	for p := strings.Trim(path, "/"); p != ""; {
		if rp, ok := l[p]; ok && (!found || rp.ReviewedAt > best.ReviewedAt) {
			best, found = rp, true
		}
		i := strings.LastIndex(p, "/")
		if i < 0 {
			break
		}
		p = p[:i]
	}
	return best, found
}
