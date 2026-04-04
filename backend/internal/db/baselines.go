package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"bench/internal/model"
)

// baselineColumns is the SELECT column list shared by all baseline queries.
const baselineColumns = `id, seq, commit_id, reviewer, summary, created_at,
	findings_total, findings_open, by_severity, by_status, by_category,
	comments_total, comments_open, finding_ids,
	features_total, features_active, feature_ids, by_kind`

// CreateBaseline inserts a new baseline with all snapshot fields in a single operation.
// Seq is auto-assigned as max(seq)+1 for the project.
func (d *DB) CreateBaseline(b *model.Baseline) error {
	bySev, _ := json.Marshal(b.BySeverity)
	byStat, _ := json.Marshal(b.ByStatus)
	byCat, _ := json.Marshal(b.ByCategory)
	findIDs, _ := json.Marshal(b.FindingIDs)
	byKind, _ := json.Marshal(b.ByKind)
	featIDs, _ := json.Marshal(b.FeatureIDs)
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT INTO baselines (id, project_id, seq, commit_id, reviewer, summary, created_at,
			findings_total, findings_open, by_severity, by_status, by_category,
			comments_total, comments_open, finding_ids,
			features_total, features_active, feature_ids, by_kind)
		VALUES (?, ?,
			COALESCE((SELECT MAX(seq) FROM baselines WHERE project_id = ?), 0) + 1,
			?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			b.ID, d.projectID, d.projectID,
			b.CommitID, b.Reviewer, b.Summary,
			b.FindingsTotal, b.FindingsOpen, string(bySev), string(byStat), string(byCat),
			b.CommentsTotal, b.CommentsOpen, string(findIDs),
			b.FeaturesTotal, b.FeaturesActive, string(featIDs), string(byKind),
		)
		return err
	})
}

// GetLatestBaseline returns the most recent baseline, or nil if none.
func (d *DB) GetLatestBaseline() (*model.Baseline, error) {
	return d.scanBaseline(
		`SELECT `+baselineColumns+`
		FROM baselines WHERE project_id = ?
		ORDER BY created_at DESC LIMIT 1`,
		d.projectID,
	)
}

// GetBaselineByID returns a baseline by its ID, or nil if not found.
func (d *DB) GetBaselineByID(id string) (*model.Baseline, error) {
	return d.scanBaseline(
		`SELECT `+baselineColumns+`
		FROM baselines WHERE id = ? AND project_id = ?`,
		id, d.projectID,
	)
}

// GetPreviousBaseline returns the baseline created just before the given one.
// Uses rowid for tie-breaking when timestamps match (datetime has 1-second resolution).
func (d *DB) GetPreviousBaseline(baselineID string) (*model.Baseline, error) {
	return d.scanBaseline(
		`SELECT `+baselineColumns+`
		FROM baselines
		WHERE project_id = ?
			AND rowid < (SELECT rowid FROM baselines WHERE id = ? AND project_id = ?)
		ORDER BY rowid DESC LIMIT 1`,
		d.projectID, baselineID, d.projectID,
	)
}

// ListBaselines returns all baselines for the project, most recent first.
func (d *DB) ListBaselines(limit int) ([]model.Baseline, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := d.conn.Query(
		`SELECT `+baselineColumns+`
		FROM baselines WHERE project_id = ?
		ORDER BY created_at DESC LIMIT ?`,
		d.projectID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list baselines: %w", err)
	}
	defer rows.Close()

	var baselines []model.Baseline
	for rows.Next() {
		b, err := d.scanBaselineRow(rows)
		if err != nil {
			return nil, err
		}
		baselines = append(baselines, *b)
	}
	return baselines, rows.Err()
}

// UpdateBaseline updates mutable fields (reviewer, summary) of a baseline.
func (d *DB) UpdateBaseline(id string, reviewer, summary *string) error {
	if reviewer == nil && summary == nil {
		return nil
	}
	sets := []string{}
	args := []any{}
	if reviewer != nil {
		sets = append(sets, "reviewer = ?")
		args = append(args, *reviewer)
	}
	if summary != nil {
		sets = append(sets, "summary = ?")
		args = append(args, *summary)
	}
	args = append(args, id, d.projectID)
	query := fmt.Sprintf("UPDATE baselines SET %s WHERE id = ? AND project_id = ?",
		strings.Join(sets, ", "))
	return wq0(d.wq, func() error {
		res, err := d.conn.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("update baseline: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("baseline not found")
		}
		return nil
	})
}

// DeleteBaseline deletes a baseline by its ID.
func (d *DB) DeleteBaseline(id string) error {
	return wq0(d.wq, func() error {
		res, err := d.conn.Exec(
			`DELETE FROM baselines WHERE id = ? AND project_id = ?`,
			id, d.projectID,
		)
		if err != nil {
			return fmt.Errorf("delete baseline: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("baseline not found")
		}
		return nil
	})
}

// AllFindingIDs returns all finding IDs for the project.
func (d *DB) AllFindingIDs() ([]string, error) {
	rows, err := d.conn.Query(
		`SELECT id FROM findings WHERE project_id = ? ORDER BY created_at`,
		d.projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list finding ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan finding id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// scanBaseline executes a query returning a single baseline row.
func (d *DB) scanBaseline(query string, args ...any) (*model.Baseline, error) {
	var b model.Baseline
	var bySev, byStat, byCat, findIDs string
	var byKind, featIDs string
	err := d.conn.QueryRow(query, args...).Scan(
		&b.ID, &b.Seq, &b.CommitID, &b.Reviewer, &b.Summary, &b.CreatedAt,
		&b.FindingsTotal, &b.FindingsOpen, &bySev, &byStat, &byCat,
		&b.CommentsTotal, &b.CommentsOpen, &findIDs,
		&b.FeaturesTotal, &b.FeaturesActive, &featIDs, &byKind,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scan baseline: %w", err)
	}
	unmarshalBaselineJSON(&b, bySev, byStat, byCat, findIDs, byKind, featIDs)
	return &b, nil
}

// scanBaselineRow scans a baseline from an active rows cursor.
func (d *DB) scanBaselineRow(rows *sql.Rows) (*model.Baseline, error) {
	var b model.Baseline
	var bySev, byStat, byCat, findIDs string
	var byKind, featIDs string
	if err := rows.Scan(
		&b.ID, &b.Seq, &b.CommitID, &b.Reviewer, &b.Summary, &b.CreatedAt,
		&b.FindingsTotal, &b.FindingsOpen, &bySev, &byStat, &byCat,
		&b.CommentsTotal, &b.CommentsOpen, &findIDs,
		&b.FeaturesTotal, &b.FeaturesActive, &featIDs, &byKind,
	); err != nil {
		return nil, fmt.Errorf("scan baseline row: %w", err)
	}
	unmarshalBaselineJSON(&b, bySev, byStat, byCat, findIDs, byKind, featIDs)
	return &b, nil
}

func unmarshalBaselineJSON(b *model.Baseline, bySev, byStat, byCat, findIDs, byKind, featIDs string) {
	if err := json.Unmarshal([]byte(bySev), &b.BySeverity); err != nil {
		b.BySeverity = map[string]int{}
	}
	if err := json.Unmarshal([]byte(byStat), &b.ByStatus); err != nil {
		b.ByStatus = map[string]int{}
	}
	if err := json.Unmarshal([]byte(byCat), &b.ByCategory); err != nil {
		b.ByCategory = map[string]int{}
	}
	if err := json.Unmarshal([]byte(findIDs), &b.FindingIDs); err != nil {
		b.FindingIDs = []string{}
	}
	if err := json.Unmarshal([]byte(byKind), &b.ByKind); err != nil {
		b.ByKind = map[string]int{}
	}
	if err := json.Unmarshal([]byte(featIDs), &b.FeatureIDs); err != nil {
		b.FeatureIDs = []string{}
	}
}
