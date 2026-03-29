package db

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	dir := t.TempDir()
	d, err := Open(filepath.Join(dir, "test.db"), "_standalone")
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestOpenScoped_Isolation(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "shared.db")

	// Open standalone to run migrations
	standalone, err := Open(dbPath, "test")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	standalone.Close()

	// Open shared connection
	conn, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer conn.Close()

	projA := OpenScoped(conn, "proj_a")
	projB := OpenScoped(conn, "proj_b")

	// Insert a finding into project A
	_, err = conn.Exec(
		`INSERT INTO findings (project_id, id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('proj_a', 'f1', 'src/a.go', 'aaa', 'high', 'SQLi in A', 'open', 'mcp')`)
	if err != nil {
		t.Fatal(err)
	}

	// Insert a finding into project B
	_, err = conn.Exec(
		`INSERT INTO findings (project_id, id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('proj_b', 'f2', 'src/b.go', 'bbb', 'low', 'XSS in B', 'open', 'mcp')`)
	if err != nil {
		t.Fatal(err)
	}

	// Project A should only see its finding
	findingsA, _, err := projA.ListFindings("", 0, 0)
	if err != nil {
		t.Fatalf("ListFindings A: %v", err)
	}
	if len(findingsA) != 1 || findingsA[0].ID != "f1" {
		t.Fatalf("expected 1 finding (f1) in project A, got %d: %+v", len(findingsA), findingsA)
	}

	// Project B should only see its finding
	findingsB, _, err := projB.ListFindings("", 0, 0)
	if err != nil {
		t.Fatalf("ListFindings B: %v", err)
	}
	if len(findingsB) != 1 || findingsB[0].ID != "f2" {
		t.Fatalf("expected 1 finding (f2) in project B, got %d: %+v", len(findingsB), findingsB)
	}

	// Project A can't get project B's finding
	_, err = projA.GetFinding("f2")
	if err == nil {
		t.Fatal("expected error getting f2 from project A scope")
	}

	// Summary should be scoped
	summaryA, err := projA.FindingSummary()
	if err != nil {
		t.Fatalf("FindingSummary A: %v", err)
	}
	if len(summaryA) != 1 || summaryA[0].Severity != "high" {
		t.Fatalf("expected 1 high finding in summary A, got %+v", summaryA)
	}

	summaryB, err := projB.FindingSummary()
	if err != nil {
		t.Fatalf("FindingSummary B: %v", err)
	}
	if len(summaryB) != 1 || summaryB[0].Severity != "low" {
		t.Fatalf("expected 1 low finding in summary B, got %+v", summaryB)
	}
}

func TestOpenScoped_Close_DoesNotCloseSharedConn(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "shared.db")

	standalone, err := Open(dbPath, "test")
	if err != nil {
		t.Fatal(err)
	}
	standalone.Close()

	conn, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	scoped := OpenScoped(conn, "proj_x")
	scoped.Close() // should NOT close conn

	// conn should still work
	var n int
	if err := conn.QueryRow("SELECT 1").Scan(&n); err != nil {
		t.Fatalf("shared conn should still work after scoped Close: %v", err)
	}
}

func TestRunMigrations(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "platform.db")

	conn, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if err := RunMigrations(conn); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}

	// Verify tables exist with project_id column
	for _, tbl := range []string{"findings", "comments", "annotation_positions", "reconciliation_log", "review_progress"} {
		var n int
		err := conn.QueryRow("SELECT COUNT(*) FROM " + tbl + " WHERE project_id = '_standalone'").Scan(&n)
		if err != nil {
			t.Fatalf("table %s missing or no project_id column: %v", tbl, err)
		}
	}
}

func TestListAnnotatedFiles_ExcludesEmptyFileID(t *testing.T) {
	d := openTestDB(t)

	// Valid finding
	_, err := d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('F1', 'src/auth.py', 'aaa', 'high', 'test', 'open', 'pentest')`)
	if err != nil {
		t.Fatal(err)
	}

	// Finding with empty anchor_file_id (project-level)
	_, err = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('F2', '', 'bbb', 'info', 'project note', 'open', 'manual')`)
	if err != nil {
		t.Fatal(err)
	}

	// Comment with empty anchor_file_id
	_, err = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('C1', '', 'ccc', 'tester', 'project comment', '2024-01-01', 'T1')`)
	if err != nil {
		t.Fatal(err)
	}

	// Valid comment
	_, err = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('C2', 'src/db.py', 'ddd', 'tester', 'file comment', '2024-01-02', 'T2')`)
	if err != nil {
		t.Fatal(err)
	}

	files, err := d.ListAnnotatedFiles()
	if err != nil {
		t.Fatal(err)
	}

	// Should contain exactly 2 valid paths, no empty strings
	if len(files) != 2 {
		t.Fatalf("expected 2 files, got %d: %v", len(files), files)
	}
	for _, f := range files {
		if f == "" {
			t.Fatal("ListAnnotatedFiles returned an empty string file ID")
		}
	}

	got := make(map[string]bool)
	for _, f := range files {
		got[f] = true
	}
	if !got["src/auth.py"] {
		t.Error("missing src/auth.py")
	}
	if !got["src/db.py"] {
		t.Error("missing src/db.py")
	}
}

func TestListAnnotatedFiles_EmptyDB(t *testing.T) {
	d := openTestDB(t)

	files, err := d.ListAnnotatedFiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("expected 0 files, got %d", len(files))
	}
}

func TestListAnnotatedFiles_AllEmpty_ReturnsNone(t *testing.T) {
	d := openTestDB(t)

	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('F1', '', 'aaa', 'info', 'x', 'open', 'manual')`)
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('C1', '', 'bbb', 'u', 'y', '2024-01-01', 'T1')`)

	files, err := d.ListAnnotatedFiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("expected 0 files when all have empty IDs, got %d: %v", len(files), files)
	}
}

func TestListAnnotatedFiles_Deduplication(t *testing.T) {
	d := openTestDB(t)

	// Same file referenced by both a finding and a comment
	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('F1', 'src/auth.py', 'aaa', 'high', 'x', 'open', 'pentest')`)
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('C1', 'src/auth.py', 'bbb', 'u', 'y', '2024-01-01', 'T1')`)

	files, err := d.ListAnnotatedFiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 deduplicated file, got %d: %v", len(files), files)
	}
	if files[0] != "src/auth.py" {
		t.Fatalf("expected src/auth.py, got %s", files[0])
	}
}
