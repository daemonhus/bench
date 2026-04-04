package db

import (
	"database/sql"
	"fmt"
	"strings"

	"bench/internal/model"
)

// InsertPosition stores an annotation position entry (delta storage —
// only call when position or confidence has changed).
func (d *DB) InsertPosition(p *model.AnnotationPosition) error {
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT OR REPLACE INTO annotation_positions
			(project_id, annotation_id, annotation_type, commit_id, file_id, line_start, line_end, confidence)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			d.projectID, p.AnnotationID, p.AnnotationType, p.CommitID,
			p.FileID, p.LineStart, p.LineEnd, p.Confidence,
		)
		return err
	})
}

// GetPositions returns all stored position entries for an annotation,
// ordered by created_at ascending.
func (d *DB) GetPositions(annotationID, annotationType string) ([]model.AnnotationPosition, error) {
	rows, err := d.conn.Query(
		`SELECT annotation_id, annotation_type, commit_id, file_id, line_start, line_end, confidence, created_at
		FROM annotation_positions
		WHERE annotation_id = ? AND annotation_type = ? AND project_id = ?
		ORDER BY created_at ASC`,
		annotationID, annotationType, d.projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("query positions: %w", err)
	}
	defer rows.Close()

	var positions []model.AnnotationPosition
	for rows.Next() {
		var p model.AnnotationPosition
		var fileID sql.NullString
		var lineStart, lineEnd sql.NullInt64
		err := rows.Scan(&p.AnnotationID, &p.AnnotationType, &p.CommitID,
			&fileID, &lineStart, &lineEnd, &p.Confidence, &p.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("scan position: %w", err)
		}
		if fileID.Valid {
			p.FileID = &fileID.String
		}
		if lineStart.Valid {
			v := int(lineStart.Int64)
			p.LineStart = &v
		}
		if lineEnd.Valid {
			v := int(lineEnd.Int64)
			p.LineEnd = &v
		}
		positions = append(positions, p)
	}
	return positions, rows.Err()
}

// DeletePositions removes position entries for specific commits.
// Used during rebase handling to invalidate stale positions.
func (d *DB) DeletePositions(annotationID, annotationType string, commitIDs []string) error {
	if len(commitIDs) == 0 {
		return nil
	}
	placeholders := make([]string, len(commitIDs))
	args := make([]any, 0, len(commitIDs)+3)
	args = append(args, annotationID, annotationType, d.projectID)
	for i, c := range commitIDs {
		placeholders[i] = "?"
		args = append(args, c)
	}
	query := fmt.Sprintf(
		`DELETE FROM annotation_positions
		WHERE annotation_id = ? AND annotation_type = ? AND project_id = ? AND commit_id IN (%s)`,
		strings.Join(placeholders, ","),
	)
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(query, args...)
		return err
	})
}
