package db

import (
	"fmt"
	"strings"
	"time"

	"bench/internal/model"

	"github.com/google/uuid"
)

// enrichWithRefs batch-queries refs and populates Refs on each entity.
// entityType is "finding", "feature", or "comment".
// ids is a parallel slice matching the index order of the target slice.
func (d *DB) enrichWithRefs(entityType string, ids []string) (map[string][]model.Ref, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+2)
	args = append(args, d.projectID, entityType)
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}
	query := fmt.Sprintf(
		`SELECT id, entity_type, entity_id, provider, url, title, created_at FROM refs
		WHERE project_id = ? AND entity_type = ? AND entity_id IN (%s)
		ORDER BY created_at ASC`,
		strings.Join(placeholders, ","),
	)
	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query refs: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]model.Ref)
	for rows.Next() {
		var r model.Ref
		if err := rows.Scan(&r.ID, &r.EntityType, &r.EntityID, &r.Provider, &r.URL, &r.Title, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan ref: %w", err)
		}
		result[r.EntityID] = append(result[r.EntityID], r)
	}
	return result, rows.Err()
}

func (d *DB) ListRefs(entityType, entityID, provider string) ([]model.Ref, error) {
	conditions := []string{`project_id = ?`}
	args := []any{d.projectID}
	if entityType != "" {
		conditions = append(conditions, `entity_type = ?`)
		args = append(args, entityType)
	}
	if entityID != "" {
		conditions = append(conditions, `entity_id = ?`)
		args = append(args, entityID)
	}
	if provider != "" {
		conditions = append(conditions, `provider = ?`)
		args = append(args, provider)
	}

	query := `SELECT id, entity_type, entity_id, provider, url, title, created_at FROM refs WHERE ` +
		strings.Join(conditions, ` AND `) + ` ORDER BY created_at ASC`
	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query refs: %w", err)
	}
	defer rows.Close()

	var refs []model.Ref
	for rows.Next() {
		var r model.Ref
		if err := rows.Scan(&r.ID, &r.EntityType, &r.EntityID, &r.Provider, &r.URL, &r.Title, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan ref: %w", err)
		}
		refs = append(refs, r)
	}
	return refs, rows.Err()
}

func (d *DB) GetRef(id string) (*model.Ref, error) {
	id, err := d.resolveID("refs", id)
	if err != nil {
		return nil, err
	}
	var r model.Ref
	err = d.conn.QueryRow(
		`SELECT id, entity_type, entity_id, provider, url, title, created_at FROM refs WHERE id = ? AND project_id = ?`,
		id, d.projectID,
	).Scan(&r.ID, &r.EntityType, &r.EntityID, &r.Provider, &r.URL, &r.Title, &r.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("ref not found: %s", id)
	}
	return &r, nil
}

func (d *DB) CreateRef(r *model.Ref) error {
	if r.ID == "" {
		r.ID = uuid.New().String()
	}
	if r.CreatedAt == "" {
		r.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`INSERT INTO refs (id, project_id, entity_type, entity_id, provider, url, title, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			r.ID, d.projectID, r.EntityType, r.EntityID, r.Provider, r.URL, r.Title, r.CreatedAt,
		)
		return err
	})
}

func (d *DB) BatchCreateRefs(refs []model.Ref) ([]string, error) {
	return wq(d.wq, func() ([]string, error) {
		tx, err := d.conn.Begin()
		if err != nil {
			return nil, fmt.Errorf("begin tx: %w", err)
		}
		defer tx.Rollback()

		stmt, err := tx.Prepare(
			`INSERT INTO refs (id, project_id, entity_type, entity_id, provider, url, title, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		if err != nil {
			return nil, fmt.Errorf("prepare: %w", err)
		}
		defer stmt.Close()

		now := time.Now().UTC().Format(time.RFC3339)
		ids := make([]string, 0, len(refs))
		for i := range refs {
			r := &refs[i]
			if r.ID == "" {
				r.ID = uuid.New().String()
			}
			if r.CreatedAt == "" {
				r.CreatedAt = now
			}
			if _, err := stmt.Exec(r.ID, d.projectID, r.EntityType, r.EntityID, r.Provider, r.URL, r.Title, r.CreatedAt); err != nil {
				return nil, fmt.Errorf("insert ref %d: %w", i, err)
			}
			ids = append(ids, r.ID)
		}
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit: %w", err)
		}
		return ids, nil
	})
}

func (d *DB) UpdateRef(id string, updates map[string]any) (*model.Ref, error) {
	id, err := d.resolveID("refs", id)
	if err != nil {
		return nil, err
	}
	allowed := map[string]string{
		"provider": "provider",
		"url":      "url",
		"title":    "title",
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

	err = wq0(d.wq, func() error {
		args2 := append(args, id, d.projectID)
		query := "UPDATE refs SET " + strings.Join(setClauses, ", ") + " WHERE id = ? AND project_id = ?"
		res, err := d.conn.Exec(query, args2...)
		if err != nil {
			return fmt.Errorf("update ref: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("ref not found: %s", id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return d.GetRef(id)
}

func (d *DB) DeleteRef(id string) error {
	id, err := d.resolveID("refs", id)
	if err != nil {
		return err
	}
	return wq0(d.wq, func() error {
		res, err := d.conn.Exec(`DELETE FROM refs WHERE id = ? AND project_id = ?`, id, d.projectID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("ref not found: %s", id)
		}
		return nil
	})
}

func (d *DB) DeleteRefsForEntity(entityType, entityID string) error {
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			`DELETE FROM refs WHERE entity_type = ? AND entity_id = ? AND project_id = ?`,
			entityType, entityID, d.projectID,
		)
		return err
	})
}
