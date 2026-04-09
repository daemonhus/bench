package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"bench/internal/model"

	"github.com/google/uuid"
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
	ids := make([]string, len(features))
	for i, f := range features {
		ids[i] = f.ID
	}
	if refsMap, err := d.enrichWithRefs("feature", ids); err == nil && refsMap != nil {
		for i, f := range features {
			features[i].Refs = refsMap[f.ID]
		}
	}
	if paramsMap, err := d.enrichWithParameters(ids); err == nil {
		for i, f := range features {
			if ps, ok := paramsMap[f.ID]; ok {
				features[i].Parameters = ps
			}
		}
	}
	return features, total, nil
}

func (d *DB) GetFeature(id string) (*model.Feature, error) {
	id, err := d.resolveID("features", id)
	if err != nil {
		return nil, err
	}
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
	f, err := scanFeatureRow(rows)
	if err != nil {
		return nil, err
	}
	if refsMap, err := d.enrichWithRefs("feature", []string{f.ID}); err == nil && refsMap != nil {
		f.Refs = refsMap[f.ID]
	}
	if params, err := d.ListParameters(f.ID); err == nil {
		f.Parameters = params
	}
	return f, nil
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
	f.Parameters = []model.FeatureParameter{}
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
	id, err := d.resolveID("features", id)
	if err != nil {
		return nil, err
	}
	allowed := map[string]string{
		"kind":              "kind",
		"title":             "title",
		"description":       "description",
		"operation":         "operation",
		"direction":         "direction",
		"protocol":          "protocol",
		"status":            "status",
		"source":            "source",
		"file":              "anchor_file_id",
		"file_id":           "anchor_file_id",
		"commit":            "anchor_commit_id",
		"commit_id":         "anchor_commit_id",
		"line_start":        "anchor_line_start",
		"line_end":          "anchor_line_end",
		"line_hash":         "line_hash",
		"resolved_commit":   "resolved_commit",
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

	err = wq0(d.wq, func() error {
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
	id, err := d.resolveID("features", id)
	if err != nil {
		return err
	}
	return wq0(d.wq, func() error {
		tx, err := d.conn.Begin()
		if err != nil {
			return fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		// Delete child rows before the feature (FK constraints).
		if _, err := tx.Exec(`DELETE FROM feature_parameters WHERE feature_id = ? AND project_id = ?`, id, d.projectID); err != nil {
			return fmt.Errorf("delete feature_parameters: %w", err)
		}

		if _, err := tx.Exec(`DELETE FROM finding_features WHERE feature_id = ? AND project_id = ?`, id, d.projectID); err != nil {
			return fmt.Errorf("delete finding_features: %w", err)
		}

		if _, err := tx.Exec(`DELETE FROM refs WHERE entity_type = 'feature' AND entity_id = ? AND project_id = ?`, id, d.projectID); err != nil {
			return fmt.Errorf("delete refs: %w", err)
		}

		res, err := tx.Exec(`DELETE FROM features WHERE id = ? AND project_id = ?`, id, d.projectID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("feature not found: %s", id)
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

// ---------------------------------------------------------------------------
// Feature parameters
// ---------------------------------------------------------------------------

// enrichWithParameters batch-queries parameters and populates Parameters on each feature.
func (d *DB) enrichWithParameters(ids []string) (map[string][]model.FeatureParameter, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+1)
	args = append(args, d.projectID)
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}
	query := fmt.Sprintf(
		`SELECT id, feature_id, name, description, type, pattern, required, created_at
		FROM feature_parameters
		WHERE project_id = ? AND feature_id IN (%s)
		ORDER BY name ASC`,
		strings.Join(placeholders, ","),
	)
	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query feature_parameters: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]model.FeatureParameter)
	for rows.Next() {
		var p model.FeatureParameter
		var req int
		if err := rows.Scan(&p.ID, &p.FeatureID, &p.Name, &p.Description, &p.Type, &p.Pattern, &req, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan feature_parameter: %w", err)
		}
		p.Required = req == 1
		result[p.FeatureID] = append(result[p.FeatureID], p)
	}
	return result, rows.Err()
}

// ListParameters returns all parameters for a feature, ordered by name.
func (d *DB) ListParameters(featureID string) ([]model.FeatureParameter, error) {
	rows, err := d.conn.Query(
		`SELECT id, feature_id, name, description, type, pattern, required, created_at
		FROM feature_parameters
		WHERE project_id = ? AND feature_id = ?
		ORDER BY name ASC`,
		d.projectID, featureID,
	)
	if err != nil {
		return nil, fmt.Errorf("query feature_parameters: %w", err)
	}
	defer rows.Close()

	params := []model.FeatureParameter{}
	for rows.Next() {
		var p model.FeatureParameter
		var req int
		if err := rows.Scan(&p.ID, &p.FeatureID, &p.Name, &p.Description, &p.Type, &p.Pattern, &req, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan feature_parameter: %w", err)
		}
		p.Required = req == 1
		params = append(params, p)
	}
	return params, rows.Err()
}

// GetParameter returns a single feature parameter by ID.
func (d *DB) GetParameter(id string) (*model.FeatureParameter, error) {
	id, err := d.resolveID("feature_parameters", id)
	if err != nil {
		return nil, err
	}
	var p model.FeatureParameter
	var req int
	err = d.conn.QueryRow(
		`SELECT id, feature_id, name, description, type, pattern, required, created_at
		FROM feature_parameters WHERE id = ? AND project_id = ?`,
		id, d.projectID,
	).Scan(&p.ID, &p.FeatureID, &p.Name, &p.Description, &p.Type, &p.Pattern, &req, &p.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("parameter not found: %s", id)
	}
	p.Required = req == 1
	return &p, nil
}

// CreateParameter inserts a new feature parameter.
func (d *DB) CreateParameter(p *model.FeatureParameter) error {
	if p.ID == "" {
		p.ID = uuid.New().String()
	}
	if p.CreatedAt == "" {
		p.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	req := 0
	if p.Required {
		req = 1
	}
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT INTO feature_parameters (id, project_id, feature_id, name, description, type, pattern, required, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			p.ID, d.projectID, p.FeatureID, p.Name, p.Description, p.Type, p.Pattern, req, p.CreatedAt,
		)
		return err
	})
}

// UpdateParameter applies a partial update to a feature parameter and returns the updated record.
func (d *DB) UpdateParameter(id string, updates map[string]any) (*model.FeatureParameter, error) {
	id, err := d.resolveID("feature_parameters", id)
	if err != nil {
		return nil, err
	}
	allowed := map[string]string{
		"name":        "name",
		"description": "description",
		"type":        "type",
		"pattern":     "pattern",
	}

	var setClauses []string
	var args []any
	for jsonKey, col := range allowed {
		if v, ok := updates[jsonKey]; ok {
			setClauses = append(setClauses, col+" = ?")
			args = append(args, v)
		}
	}
	// Handle required separately (bool → int)
	if v, ok := updates["required"]; ok {
		req := 0
		if b, ok := v.(bool); ok && b {
			req = 1
		}
		setClauses = append(setClauses, "required = ?")
		args = append(args, req)
	}

	if len(setClauses) == 0 {
		return nil, fmt.Errorf("no valid fields to update")
	}

	args = append(args, id, d.projectID)
	query := "UPDATE feature_parameters SET " + strings.Join(setClauses, ", ") + " WHERE id = ? AND project_id = ?"

	err = wq0(d.wq, func() error {
		res, err := d.conn.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("update parameter: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("parameter not found: %s", id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return d.GetParameter(id)
}

// DeleteParameter removes a feature parameter by ID.
func (d *DB) DeleteParameter(id string) error {
	id, err := d.resolveID("feature_parameters", id)
	if err != nil {
		return err
	}
	return wq0(d.wq, func() error {
		res, err := d.conn.Exec(
			`DELETE FROM feature_parameters WHERE id = ? AND project_id = ?`,
			id, d.projectID,
		)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("parameter not found: %s", id)
		}
		return nil
	})
}

// ReplaceParameters atomically replaces all parameters for a feature.
func (d *DB) ReplaceParameters(featureID string, params []model.FeatureParameter) error {
	return wq0(d.wq, func() error {
		tx, err := d.conn.Begin()
		if err != nil {
			return fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		if _, err := tx.Exec(
			`DELETE FROM feature_parameters WHERE feature_id = ? AND project_id = ?`,
			featureID, d.projectID,
		); err != nil {
			return fmt.Errorf("delete parameters: %w", err)
		}

		now := time.Now().UTC().Format(time.RFC3339)
		for i := range params {
			p := &params[i]
			if p.ID == "" {
				p.ID = uuid.New().String()
			}
			if p.CreatedAt == "" {
				p.CreatedAt = now
			}
			req := 0
			if p.Required {
				req = 1
			}
			if _, err := tx.Exec(
				`INSERT INTO feature_parameters (id, project_id, feature_id, name, description, type, pattern, required, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				p.ID, d.projectID, featureID, p.Name, p.Description, p.Type, p.Pattern, req, p.CreatedAt,
			); err != nil {
				return fmt.Errorf("insert parameter %d: %w", i, err)
			}
		}

		return tx.Commit()
	})
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
