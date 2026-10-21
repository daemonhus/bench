package server

import (
	"database/sql"
	"fmt"
	"strings"

	"bench/internal/model"
)

// Links that span two projects: a feature linked to another project's feature, or a finding
// that affects another project's feature. Each project keeps its own links in its own
// database; these live here, as neither project's database can hold the other's ids. Every
// project's workbench reads and writes them through model.CrossLinks, so they come back on
// the same fields (a feature's linkedFeatures, a finding's features) as "<project>:<id>", on
// REST, MCP and the CLI alike.

func setUpCrossLinks(conn *sql.DB) error {
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS cross_links (
		from_project TEXT NOT NULL,
		from_kind    TEXT NOT NULL CHECK (from_kind IN ('feature', 'finding')),
		from_id      TEXT NOT NULL,
		to_project   TEXT NOT NULL,
		to_feature   TEXT NOT NULL,
		description  TEXT NOT NULL DEFAULT '',
		created_at   TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (from_project, from_kind, from_id, to_project, to_feature)
	)`); err != nil {
		return fmt.Errorf("create cross_links: %w", err)
	}
	if _, err := conn.Exec(`CREATE INDEX IF NOT EXISTS cross_links_to ON cross_links (to_project, to_feature)`); err != nil {
		return fmt.Errorf("index cross_links: %w", err)
	}
	return nil
}

// crossLinks is one project's view of the store.
type crossLinks struct {
	p    *Platform
	slug string
}

func (p *Platform) crossLinksFor(slug string) model.CrossLinks { return &crossLinks{p: p, slug: slug} }

func (c *crossLinks) Self() string { return c.slug }

func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }

func idArgs(lead []any, ids []string) []any {
	args := append([]any{}, lead...)
	for _, id := range ids {
		args = append(args, id)
	}
	return args
}

// target checks that a "<project>:<id>" reference names a feature that exists, and returns it
// with the feature's full id (a short id prefix is accepted, as elsewhere).
func (c *crossLinks) target(ref string) (project, id string, err error) {
	project, id, ok := model.SplitCrossRef(ref)
	if !ok {
		return "", "", fmt.Errorf("%w: %q is not a <project>:<id> reference", model.ErrUnknownFeature, ref)
	}
	wb, err := c.p.getWorkbench(project)
	if err != nil {
		return "", "", fmt.Errorf("%w: %q: no project %q", model.ErrUnknownFeature, ref, project)
	}
	f, err := wb.DB.GetFeature(id)
	if err != nil || f == nil {
		return "", "", fmt.Errorf("%w: %q is not a feature in project %q", model.ErrUnknownFeature, ref, project)
	}
	return project, f.ID, nil
}

func (c *crossLinks) FeatureLinks(ids []string) (map[string][]model.LinkedFeature, error) {
	out := map[string][]model.LinkedFeature{}
	if len(ids) == 0 {
		return out, nil
	}
	ph := placeholders(len(ids))
	// Links are one row and read from both ends: out of this project's features, and into them.
	rows, err := c.p.db.Query(`SELECT from_id, to_project, to_feature, description FROM cross_links
		WHERE from_project = ? AND from_kind = 'feature' AND from_id IN (`+ph+`)`, idArgs([]any{c.slug}, ids)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var from, project, to, desc string
		if err := rows.Scan(&from, &project, &to, &desc); err != nil {
			rows.Close()
			return nil, err
		}
		out[from] = append(out[from], model.LinkedFeature{ID: model.CrossRef(project, to), Description: desc})
	}
	rows.Close()
	rows, err = c.p.db.Query(`SELECT to_feature, from_project, from_id, description FROM cross_links
		WHERE to_project = ? AND from_kind = 'feature' AND to_feature IN (`+ph+`)`, idArgs([]any{c.slug}, ids)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var to, project, from, desc string
		if err := rows.Scan(&to, &project, &from, &desc); err != nil {
			return nil, err
		}
		out[to] = append(out[to], model.LinkedFeature{ID: model.CrossRef(project, from), Description: desc})
	}
	return out, rows.Err()
}

func (c *crossLinks) SetFeatureLinks(featureID string, links []model.LinkedFeature) error {
	type row struct{ project, id, desc string }
	resolved := make([]row, 0, len(links))
	for _, l := range links {
		project, id, err := c.target(l.ID)
		if err != nil {
			return err
		}
		resolved = append(resolved, row{project, id, l.Description})
	}
	tx, err := c.p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Replace every link touching the feature, either way, as a project's own links are.
	if _, err := tx.Exec(`DELETE FROM cross_links WHERE (from_project = ? AND from_kind = 'feature' AND from_id = ?)
		OR (from_kind = 'feature' AND to_project = ? AND to_feature = ?)`, c.slug, featureID, c.slug, featureID); err != nil {
		return err
	}
	for _, r := range resolved {
		// A link that already exists from the other end stays one row.
		if _, err := tx.Exec(`DELETE FROM cross_links WHERE from_project = ? AND from_kind = 'feature' AND from_id = ? AND to_project = ? AND to_feature = ?`,
			r.project, r.id, c.slug, featureID); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT OR REPLACE INTO cross_links (from_project, from_kind, from_id, to_project, to_feature, description) VALUES (?, 'feature', ?, ?, ?, ?)`,
			c.slug, featureID, r.project, r.id, r.desc); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (c *crossLinks) FindingFeatures(ids []string) (map[string][]string, error) {
	out := map[string][]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := c.p.db.Query(`SELECT from_id, to_project, to_feature FROM cross_links
		WHERE from_project = ? AND from_kind = 'finding' AND from_id IN (`+placeholders(len(ids))+`)`, idArgs([]any{c.slug}, ids)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var from, project, to string
		if err := rows.Scan(&from, &project, &to); err != nil {
			return nil, err
		}
		out[from] = append(out[from], model.CrossRef(project, to))
	}
	return out, rows.Err()
}

func (c *crossLinks) SetFindingFeatures(findingID string, refs []string) error {
	type row struct{ project, id string }
	resolved := make([]row, 0, len(refs))
	for _, ref := range refs {
		project, id, err := c.target(ref)
		if err != nil {
			return err
		}
		resolved = append(resolved, row{project, id})
	}
	tx, err := c.p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM cross_links WHERE from_project = ? AND from_kind = 'finding' AND from_id = ?`, c.slug, findingID); err != nil {
		return err
	}
	for _, r := range resolved {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO cross_links (from_project, from_kind, from_id, to_project, to_feature) VALUES (?, 'finding', ?, ?, ?)`,
			c.slug, findingID, r.project, r.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (c *crossLinks) FindingsOn(featureIDs []string) (map[string][]string, error) {
	out := map[string][]string{}
	if len(featureIDs) == 0 {
		return out, nil
	}
	rows, err := c.p.db.Query(`SELECT to_feature, from_project, from_id FROM cross_links
		WHERE to_project = ? AND from_kind = 'finding' AND to_feature IN (`+placeholders(len(featureIDs))+`)`, idArgs([]any{c.slug}, featureIDs)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var to, project, from string
		if err := rows.Scan(&to, &project, &from); err != nil {
			return nil, err
		}
		out[to] = append(out[to], model.CrossRef(project, from))
	}
	return out, rows.Err()
}

func (c *crossLinks) Forget(kind, id string) error {
	var err error
	switch kind {
	case "feature":
		// Its own links, and every link (from a feature or a finding) pointing at it.
		_, err = c.p.db.Exec(`DELETE FROM cross_links WHERE (from_project = ? AND from_kind = 'feature' AND from_id = ?) OR (to_project = ? AND to_feature = ?)`,
			c.slug, id, c.slug, id)
	case "finding":
		_, err = c.p.db.Exec(`DELETE FROM cross_links WHERE from_project = ? AND from_kind = 'finding' AND from_id = ?`, c.slug, id)
	default:
		err = fmt.Errorf("unknown kind %q", kind)
	}
	return err
}
