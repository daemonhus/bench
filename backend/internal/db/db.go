package db

import (
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

type DB struct {
	conn      *sql.DB
	projectID string
	ownsConn  bool
	wq        *writeQueue
}

func Open(path, projectID string) (*DB, error) {
	conn, err := sql.Open("sqlite", path+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	d := &DB{conn: conn, projectID: projectID, ownsConn: true, wq: newWriteQueue()}
	if err := d.migrate(); err != nil {
		d.wq.close()
		conn.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

// OpenScoped creates a DB that shares an existing connection, scoped to a project.
// The caller owns the connection and is responsible for closing it.
// Migrations are the caller's responsibility (call RunMigrations once at startup).
func OpenScoped(conn *sql.DB, projectID string) *DB {
	return &DB{conn: conn, projectID: projectID, wq: newWriteQueue()}
}

// RunMigrations runs all schema migrations on the given connection.
func RunMigrations(conn *sql.DB) error {
	d := &DB{conn: conn, projectID: "_"}
	return d.migrate()
}

// ProjectID returns the project scope for this database instance.
func (d *DB) ProjectID() string {
	return d.projectID
}

func (d *DB) Close() error {
	if d.wq != nil {
		d.wq.close()
	}
	if d.ownsConn {
		return d.conn.Close()
	}
	return nil
}

func (d *DB) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS findings (
			id               TEXT PRIMARY KEY,
			anchor_file_id   TEXT NOT NULL,
			anchor_commit_id TEXT NOT NULL,
			anchor_line_start INTEGER,
			anchor_line_end   INTEGER,
			severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			cwe TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('draft','open','in-progress','false-positive','accepted','closed')),
			source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('pentest','tool','manual')),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			resolved_commit TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS comments (
			id               TEXT PRIMARY KEY,
			anchor_file_id   TEXT NOT NULL,
			anchor_commit_id TEXT NOT NULL,
			anchor_line_start INTEGER,
			anchor_line_end   INTEGER,
			author TEXT NOT NULL,
			text TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			thread_id TEXT NOT NULL,
			parent_id TEXT,
			finding_id TEXT,
			resolved_commit TEXT,
			FOREIGN KEY (finding_id) REFERENCES findings(id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(anchor_file_id)`,
		`CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(anchor_file_id)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_finding ON comments(finding_id)`,

		// Reconciliation tables
		`CREATE TABLE IF NOT EXISTS annotation_positions (
			annotation_id   TEXT NOT NULL,
			annotation_type TEXT NOT NULL CHECK(annotation_type IN ('finding','comment')),
			commit_id       TEXT NOT NULL,
			file_id         TEXT,
			line_start      INTEGER,
			line_end        INTEGER,
			confidence      TEXT NOT NULL CHECK(confidence IN ('exact','moved','orphaned')),
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (annotation_id, annotation_type, commit_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_positions_commit ON annotation_positions(commit_id)`,
		`CREATE INDEX IF NOT EXISTS idx_positions_file ON annotation_positions(file_id, commit_id)`,

		`CREATE TABLE IF NOT EXISTS reconciliation_log (
			file_id         TEXT NOT NULL,
			last_commit_id  TEXT NOT NULL,
			updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (file_id)
		)`,

		`CREATE TABLE IF NOT EXISTS review_progress (
			file_id     TEXT NOT NULL,
			commit_id   TEXT NOT NULL,
			reviewer    TEXT NOT NULL DEFAULT 'mcp-client',
			note        TEXT NOT NULL DEFAULT '',
			reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (file_id, reviewer)
		)`,

		// Baselines table (atomic state snapshots)
		`CREATE TABLE IF NOT EXISTS baselines (
			id              TEXT PRIMARY KEY,
			project_id      TEXT NOT NULL DEFAULT '_standalone',
			seq             INTEGER NOT NULL DEFAULT 0,
			commit_id       TEXT NOT NULL,
			reviewer        TEXT NOT NULL DEFAULT '',
			summary         TEXT NOT NULL DEFAULT '',
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			findings_total  INTEGER NOT NULL DEFAULT 0,
			findings_open   INTEGER NOT NULL DEFAULT 0,
			by_severity     TEXT NOT NULL DEFAULT '{}',
			by_status       TEXT NOT NULL DEFAULT '{}',
			comments_total  INTEGER NOT NULL DEFAULT 0,
			comments_open   INTEGER NOT NULL DEFAULT 0,
			finding_ids     TEXT NOT NULL DEFAULT '[]'
		)`,
		`CREATE INDEX IF NOT EXISTS idx_baselines_project ON baselines(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_baselines_created ON baselines(project_id, created_at)`,

		// Settings (key-value store for editor config etc.)
		`CREATE TABLE IF NOT EXISTS settings (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,

		`CREATE TABLE IF NOT EXISTS features (
			id               TEXT PRIMARY KEY,
			project_id       TEXT NOT NULL DEFAULT '_standalone',
			anchor_file_id   TEXT NOT NULL,
			anchor_commit_id TEXT NOT NULL,
			anchor_line_start INTEGER,
			anchor_line_end   INTEGER,
			kind    TEXT NOT NULL CHECK(kind IN ('interface','source','sink','dependency','externality')),
			title   TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			direction   TEXT NOT NULL DEFAULT '',
			protocol    TEXT NOT NULL DEFAULT '',
			status  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','deprecated','removed','orphaned')),
			tags    TEXT NOT NULL DEFAULT '[]',
			source  TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			resolved_commit TEXT,
			line_hash TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_features_file    ON features(anchor_file_id)`,
		`CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_features_status  ON features(status)`,
	}
	for _, s := range stmts {
		if _, err := d.conn.Exec(s); err != nil {
			return fmt.Errorf("exec %q: %w", s[:40], err)
		}
	}

	// Migrate findings table if CHECK constraints are outdated (SQLite requires table rebuild)
	if err := d.migrateFindings(); err != nil {
		return err
	}

	// Add new columns (cve, vector, score) if they don't exist
	for _, col := range []struct{ name, ddl string }{
		{"cve", "ALTER TABLE findings ADD COLUMN cve TEXT NOT NULL DEFAULT ''"},
		{"vector", "ALTER TABLE findings ADD COLUMN vector TEXT NOT NULL DEFAULT ''"},
		{"score", "ALTER TABLE findings ADD COLUMN score REAL NOT NULL DEFAULT 0"},
	} {
		// Check if column exists by attempting to select it
		_, err := d.conn.Exec("SELECT " + col.name + " FROM findings LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec(col.ddl); err2 != nil {
				return fmt.Errorf("add column %s: %w", col.name, err2)
			}
		}
	}

	// Add resolved_commit column to findings and comments if missing
	for _, tbl := range []string{"findings", "comments"} {
		_, err := d.conn.Exec("SELECT resolved_commit FROM " + tbl + " LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE " + tbl + " ADD COLUMN resolved_commit TEXT"); err2 != nil {
				return fmt.Errorf("add resolved_commit to %s: %w", tbl, err2)
			}
		}
	}

	// Add line_hash column to findings and comments if missing
	for _, tbl := range []string{"findings", "comments"} {
		_, err := d.conn.Exec("SELECT line_hash FROM " + tbl + " LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE " + tbl + " ADD COLUMN line_hash TEXT NOT NULL DEFAULT ''"); err2 != nil {
				return fmt.Errorf("add line_hash to %s: %w", tbl, err2)
			}
		}
	}

	// Add comment_type column to comments if missing
	{
		_, err := d.conn.Exec("SELECT comment_type FROM comments LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE comments ADD COLUMN comment_type TEXT NOT NULL DEFAULT ''"); err2 != nil {
				return fmt.Errorf("add comment_type to comments: %w", err2)
			}
		}
	}

	// Add feature_id column to comments if missing
	{
		_, err := d.conn.Exec("SELECT feature_id FROM comments LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE comments ADD COLUMN feature_id TEXT"); err2 != nil {
				return fmt.Errorf("add feature_id to comments: %w", err2)
			}
		}
	}

	// Add external_id column to findings if missing (must be before migrateSource which references it)
	{
		_, err := d.conn.Exec("SELECT external_id FROM findings LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE findings ADD COLUMN external_id TEXT NOT NULL DEFAULT ''"); err2 != nil {
				return fmt.Errorf("add external_id to findings: %w", err2)
			}
		}
	}

	// Add category column to findings if missing
	{
		_, err := d.conn.Exec("SELECT category FROM findings LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE findings ADD COLUMN category TEXT NOT NULL DEFAULT ''"); err2 != nil {
				return fmt.Errorf("add category to findings: %w", err2)
			}
		}
	}

	// Migrate source CHECK to include 'mcp' (must run after column additions)
	if err := d.migrateSource(); err != nil {
		return err
	}

	// Migrate annotation_positions to allow 'feature' annotation_type
	if err := d.migrateAnnotationPositions(); err != nil {
		return err
	}

	// Add project_id column to all tables (for existing databases)
	for _, tbl := range []string{"findings", "comments", "annotation_positions", "reconciliation_log", "review_progress"} {
		_, err := d.conn.Exec("SELECT project_id FROM " + tbl + " LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE " + tbl + " ADD COLUMN project_id TEXT NOT NULL DEFAULT '_standalone'"); err2 != nil {
				return fmt.Errorf("add project_id to %s: %w", tbl, err2)
			}
		}
	}

	// Rebuild reconciliation_log if PK doesn't include project_id
	if err := d.migratePK("reconciliation_log",
		`CREATE TABLE reconciliation_log_new (
			project_id      TEXT NOT NULL DEFAULT '_standalone',
			file_id         TEXT NOT NULL,
			last_commit_id  TEXT NOT NULL,
			updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (project_id, file_id)
		)`,
		`INSERT INTO reconciliation_log_new (project_id, file_id, last_commit_id, updated_at)
			SELECT project_id, file_id, last_commit_id, updated_at FROM reconciliation_log`,
	); err != nil {
		return err
	}

	// Rebuild review_progress if PK doesn't include project_id
	if err := d.migratePK("review_progress",
		`CREATE TABLE review_progress_new (
			project_id  TEXT NOT NULL DEFAULT '_standalone',
			file_id     TEXT NOT NULL,
			commit_id   TEXT NOT NULL,
			reviewer    TEXT NOT NULL DEFAULT 'mcp-client',
			note        TEXT NOT NULL DEFAULT '',
			reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (project_id, file_id, reviewer)
		)`,
		`INSERT INTO review_progress_new (project_id, file_id, commit_id, reviewer, note, reviewed_at)
			SELECT project_id, file_id, commit_id, reviewer, note, reviewed_at FROM review_progress`,
	); err != nil {
		return err
	}

	// Drop legacy review tables and any baselines migrated from them.
	// The old review system auto-completed reviews with placeholder summaries
	// ("Superseded by new review") that pollute the baselines list.
	{
		var hasReviews bool
		err := d.conn.QueryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reviews'").Scan(&hasReviews)
		if err == nil && hasReviews {
			// Remove baselines that were migrated from the old reviews table
			d.conn.Exec(`DELETE FROM baselines WHERE id IN (SELECT id FROM reviews)`)
			d.conn.Exec(`DROP TABLE IF EXISTS review_snapshots`)
			d.conn.Exec(`DROP TABLE IF EXISTS reviews`)
		}
	}

	// Add seq column to baselines if missing
	{
		_, err := d.conn.Exec("SELECT seq FROM baselines LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE baselines ADD COLUMN seq INTEGER NOT NULL DEFAULT 0"); err2 != nil {
				return fmt.Errorf("add seq to baselines: %w", err2)
			}
			// Backfill seq for existing baselines (ordered by created_at per project)
			d.conn.Exec(`UPDATE baselines SET seq = (
				SELECT COUNT(*) FROM baselines b2
				WHERE b2.project_id = baselines.project_id AND b2.rowid <= baselines.rowid
			)`)
		}
	}

	// Add by_category column to baselines if missing
	{
		_, err := d.conn.Exec("SELECT by_category FROM baselines LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE baselines ADD COLUMN by_category TEXT NOT NULL DEFAULT '{}'"); err2 != nil {
				return fmt.Errorf("add by_category to baselines: %w", err2)
			}
		}
	}

	// Add operation column to features if missing
	if _, err := d.conn.Exec(`SELECT operation FROM features LIMIT 0`); err != nil {
		if _, err2 := d.conn.Exec(`ALTER TABLE features ADD COLUMN operation TEXT NOT NULL DEFAULT ''`); err2 != nil {
			return fmt.Errorf("add column operation to features: %w", err2)
		}
	}

	// Add features columns to baselines if missing
	for _, col := range []struct{ name, ddl string }{
		{"features_total", "ALTER TABLE baselines ADD COLUMN features_total INTEGER NOT NULL DEFAULT 0"},
		{"features_active", "ALTER TABLE baselines ADD COLUMN features_active INTEGER NOT NULL DEFAULT 0"},
		{"feature_ids", "ALTER TABLE baselines ADD COLUMN feature_ids TEXT NOT NULL DEFAULT '[]'"},
		{"by_kind", "ALTER TABLE baselines ADD COLUMN by_kind TEXT NOT NULL DEFAULT '{}'"},
	} {
		_, err := d.conn.Exec("SELECT " + col.name + " FROM baselines LIMIT 0")
		if err != nil {
			if _, err2 := d.conn.Exec(col.ddl); err2 != nil {
				return fmt.Errorf("add column %s to baselines: %w", col.name, err2)
			}
		}
	}

	// Add anchor_updated_at column to findings, comments, features if missing
	for _, tbl := range []string{"findings", "comments", "features"} {
		if _, err := d.conn.Exec("SELECT anchor_updated_at FROM " + tbl + " LIMIT 0"); err != nil {
			if _, err2 := d.conn.Exec("ALTER TABLE " + tbl + " ADD COLUMN anchor_updated_at TEXT"); err2 != nil {
				return fmt.Errorf("add anchor_updated_at to %s: %w", tbl, err2)
			}
		}
	}

	// Add project_id indexes
	for _, idx := range []string{
		`CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_positions_project ON annotation_positions(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)`,
	} {
		if _, err := d.conn.Exec(idx); err != nil {
			return fmt.Errorf("create index: %w", err)
		}
	}

	return nil
}

// migrateSource rebuilds the findings table if the source CHECK constraint doesn't include 'mcp'.
func (d *DB) migrateSource() error {
	// Test if 'mcp' source is accepted
	_, err := d.conn.Exec(`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		VALUES ('__migrate_source_test__', '', '', 'info', '', 'draft', 'mcp')`)
	if err == nil {
		d.conn.Exec(`DELETE FROM findings WHERE id = '__migrate_source_test__'`)
		return nil
	}

	// Rebuild with updated CHECK
	migrate := []string{
		`CREATE TABLE findings_new (
			id               TEXT PRIMARY KEY,
			anchor_file_id   TEXT NOT NULL,
			anchor_commit_id TEXT NOT NULL,
			anchor_line_start INTEGER,
			anchor_line_end   INTEGER,
			severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			cwe TEXT NOT NULL DEFAULT '',
			cve TEXT NOT NULL DEFAULT '',
			vector TEXT NOT NULL DEFAULT '',
			score REAL NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('draft','open','in-progress','false-positive','accepted','closed')),
			source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('pentest','tool','manual','mcp')),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			resolved_commit TEXT,
			line_hash TEXT NOT NULL DEFAULT '',
			external_id TEXT NOT NULL DEFAULT '',
			category TEXT NOT NULL DEFAULT ''
		)`,
		`INSERT INTO findings_new SELECT id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end,
			severity, title, description, cwe, cve, vector, score, status, source, created_at, resolved_commit, line_hash,
			COALESCE(external_id, ''), COALESCE(category, '') FROM findings`,
		`DROP TABLE findings`,
		`ALTER TABLE findings_new RENAME TO findings`,
		`CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(anchor_file_id)`,
		`CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status)`,
	}
	for _, s := range migrate {
		if _, err := d.conn.Exec(s); err != nil {
			return fmt.Errorf("migrate source: %w", err)
		}
	}
	return nil
}

// migratePK rebuilds a table if its PRIMARY KEY doesn't include project_id.
func (d *DB) migratePK(tableName, createNew, insertInto string) error {
	var tableSQL string
	err := d.conn.QueryRow(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name=?", tableName,
	).Scan(&tableSQL)
	if err != nil {
		return nil // table doesn't exist
	}
	if strings.Contains(strings.ToLower(tableSQL), "project_id") &&
		strings.Contains(tableSQL, "PRIMARY KEY") {
		// Check if project_id is part of the PK (in the PRIMARY KEY clause)
		pkStart := strings.Index(tableSQL, "PRIMARY KEY")
		if pkStart >= 0 {
			pkClause := tableSQL[pkStart:]
			pkEnd := strings.Index(pkClause, ")")
			if pkEnd >= 0 && strings.Contains(pkClause[:pkEnd], "project_id") {
				return nil // already migrated
			}
		}
	}
	stmts := []string{
		createNew,
		insertInto,
		"DROP TABLE " + tableName,
		"ALTER TABLE " + tableName + "_new RENAME TO " + tableName,
	}
	for _, s := range stmts {
		if _, err := d.conn.Exec(s); err != nil {
			return fmt.Errorf("migrate PK %s: %w", tableName, err)
		}
	}
	return nil
}

// migrateAnnotationPositions rebuilds the annotation_positions table to allow 'feature' in the CHECK constraint.
func (d *DB) migrateAnnotationPositions() error {
	// Test if 'feature' annotation_type is accepted
	_, err := d.conn.Exec(`INSERT INTO annotation_positions (annotation_id, annotation_type, commit_id, confidence)
		VALUES ('__migrate_ap_test__', 'feature', '__test__', 'exact')`)
	if err == nil {
		d.conn.Exec(`DELETE FROM annotation_positions WHERE annotation_id = '__migrate_ap_test__'`)
		return nil
	}

	// Rebuild with updated CHECK
	migrate := []string{
		`CREATE TABLE annotation_positions_new (
			annotation_id   TEXT NOT NULL,
			annotation_type TEXT NOT NULL CHECK(annotation_type IN ('finding','comment','feature')),
			commit_id       TEXT NOT NULL,
			file_id         TEXT,
			line_start      INTEGER,
			line_end        INTEGER,
			confidence      TEXT NOT NULL CHECK(confidence IN ('exact','moved','orphaned')),
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (annotation_id, annotation_type, commit_id)
		)`,
		`INSERT INTO annotation_positions_new SELECT annotation_id, annotation_type, commit_id, file_id, line_start, line_end, confidence, created_at FROM annotation_positions`,
		`DROP TABLE annotation_positions`,
		`ALTER TABLE annotation_positions_new RENAME TO annotation_positions`,
		`CREATE INDEX IF NOT EXISTS idx_positions_commit ON annotation_positions(commit_id)`,
		`CREATE INDEX IF NOT EXISTS idx_positions_file ON annotation_positions(file_id, commit_id)`,
	}
	for _, s := range migrate {
		if _, err := d.conn.Exec(s); err != nil {
			return fmt.Errorf("migrate annotation_positions: %w", err)
		}
	}
	return nil
}

// migrateFindings rebuilds the findings table if the CHECK constraints are from the old schema.
func (d *DB) migrateFindings() error {
	// Try inserting a row with new status to test if constraints are current
	_, err := d.conn.Exec(`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		VALUES ('__migrate_test__', '', '', 'info', '', 'draft', 'manual')`)
	if err == nil {
		// New constraints work — clean up test row
		d.conn.Exec(`DELETE FROM findings WHERE id = '__migrate_test__'`)
		return nil
	}

	// Old constraints — rebuild table
	migrate := []string{
		`CREATE TABLE findings_new (
			id               TEXT PRIMARY KEY,
			anchor_file_id   TEXT NOT NULL,
			anchor_commit_id TEXT NOT NULL,
			anchor_line_start INTEGER,
			anchor_line_end   INTEGER,
			severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			cwe TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('draft','open','in-progress','false-positive','accepted','closed')),
			source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('pentest','tool','manual')),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			resolved_commit TEXT
		)`,
		`INSERT INTO findings_new SELECT * FROM findings`,
		`DROP TABLE findings`,
		`ALTER TABLE findings_new RENAME TO findings`,
		`CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(anchor_file_id)`,
		`CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status)`,
	}
	for _, s := range migrate {
		if _, err := d.conn.Exec(s); err != nil {
			return fmt.Errorf("migrate findings: %w", err)
		}
	}
	return nil
}
