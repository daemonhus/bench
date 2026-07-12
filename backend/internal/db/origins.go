package db

import (
	"database/sql"
	"fmt"
	"strings"

	"bench/internal/model"
)

// originTable maps an origin entity type to the table its IDs live in, both
// for prefix resolution and as an allowlist.
func originTable(entityType string) (string, error) {
	switch entityType {
	case "finding":
		return "findings", nil
	case "feature":
		return "features", nil
	default:
		return "", fmt.Errorf("unknown origin entity type: %q", entityType)
	}
}

// GetOrigin returns the origin for an entity, or nil when never set.
func (d *DB) GetOrigin(entityType, entityID string) (*model.Origin, error) {
	table, err := originTable(entityType)
	if err != nil {
		return nil, err
	}
	id, err := d.resolveID(table, entityID)
	if err != nil {
		return nil, err
	}
	var o model.Origin
	err = d.conn.QueryRow(
		`SELECT explanation, introduced_commit, introduced_date, actor, branch, updated_at
		 FROM origins WHERE entity_type = ? AND entity_id = ? AND project_id = ?`, entityType, id, d.projectID,
	).Scan(&o.Explanation, &o.IntroducedCommit, &o.IntroducedDate, &o.Actor, &o.Branch, &o.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query origin: %w", err)
	}
	return &o, nil
}

// PutOrigin upserts the full origin record for an entity. Callers merge
// partial updates into the current record before calling.
func (d *DB) PutOrigin(entityType, entityID string, o model.Origin) error {
	table, err := originTable(entityType)
	if err != nil {
		return err
	}
	id, err := d.resolveID(table, entityID)
	if err != nil {
		return err
	}
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT INTO origins (entity_type, entity_id, project_id, explanation, introduced_commit, introduced_date, actor, branch, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
			 ON CONFLICT(entity_type, entity_id) DO UPDATE SET
				explanation = excluded.explanation,
				introduced_commit = excluded.introduced_commit,
				introduced_date = excluded.introduced_date,
				actor = excluded.actor,
				branch = excluded.branch,
				updated_at = datetime('now')`,
			entityType, id, d.projectID, o.Explanation, o.IntroducedCommit, o.IntroducedDate, o.Actor, o.Branch)
		if err != nil {
			return fmt.Errorf("upsert origin: %w", err)
		}
		return nil
	})
}

// DeleteOrigin removes the origin; deleting a missing origin is a no-op.
func (d *DB) DeleteOrigin(entityType, entityID string) error {
	table, err := originTable(entityType)
	if err != nil {
		return err
	}
	id, err := d.resolveID(table, entityID)
	if err != nil {
		return err
	}
	return wq0(d.wq, func() error {
		if _, err := d.conn.Exec(`DELETE FROM origins WHERE entity_type = ? AND entity_id = ? AND project_id = ?`, entityType, id, d.projectID); err != nil {
			return fmt.Errorf("delete origin: %w", err)
		}
		return nil
	})
}

// loadOrigins batch-loads origins for a set of entity IDs of one type.
func (d *DB) loadOrigins(entityType string, ids []string) (map[string]*model.Origin, error) {
	if len(ids) == 0 {
		return map[string]*model.Origin{}, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+2)
	args = append(args, entityType, d.projectID)
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}
	query := fmt.Sprintf(
		`SELECT entity_id, explanation, introduced_commit, introduced_date, actor, branch, updated_at
		 FROM origins WHERE entity_type = ? AND project_id = ? AND entity_id IN (%s)`,
		strings.Join(placeholders, ","),
	)
	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query origins: %w", err)
	}
	defer rows.Close()

	out := make(map[string]*model.Origin, len(ids))
	for rows.Next() {
		var id string
		var o model.Origin
		if err := rows.Scan(&id, &o.Explanation, &o.IntroducedCommit, &o.IntroducedDate, &o.Actor, &o.Branch, &o.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan origin: %w", err)
		}
		origin := o
		out[id] = &origin
	}
	return out, rows.Err()
}

// enrichWithOrigins batch-loads origins onto findings.
func (d *DB) enrichWithOrigins(findings []model.Finding) error {
	ids := make([]string, len(findings))
	for i, f := range findings {
		ids[i] = f.ID
	}
	origins, err := d.loadOrigins("finding", ids)
	if err != nil {
		return err
	}
	for i, f := range findings {
		findings[i].Origin = origins[f.ID]
	}
	return nil
}

// enrichFeaturesWithOrigins batch-loads origins onto features.
func (d *DB) enrichFeaturesWithOrigins(features []model.Feature) error {
	ids := make([]string, len(features))
	for i, f := range features {
		ids[i] = f.ID
	}
	origins, err := d.loadOrigins("feature", ids)
	if err != nil {
		return err
	}
	for i, f := range features {
		features[i].Origin = origins[f.ID]
	}
	return nil
}
