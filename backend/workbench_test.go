package workbench

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func openConn(path string) (*sql.DB, error) {
	return sql.Open("sqlite", path+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)")
}

func TestOpen_And_Stats(t *testing.T) {
	dir := t.TempDir()
	// Use the test dir as a "repo" — git operations will fail but Open should succeed
	wb, err := Open(dir, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer wb.Close()

	// Empty DB should return zero stats
	stats, err := wb.Stats()
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.FindingsTotal != 0 {
		t.Errorf("expected 0 findings, got %d", stats.FindingsTotal)
	}
	if stats.CommentsTotal != 0 {
		t.Errorf("expected 0 comments, got %d", stats.CommentsTotal)
	}
}

func TestOpen_Handler(t *testing.T) {
	dir := t.TempDir()
	wb, err := Open(dir, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer wb.Close()

	// Handler, APIHandler, MCPHandler should all be non-nil
	if wb.Handler() == nil {
		t.Fatal("Handler() returned nil")
	}
	if wb.APIHandler() == nil {
		t.Fatal("APIHandler() returned nil")
	}
	if wb.MCPHandler() == nil {
		t.Fatal("MCPHandler() returned nil")
	}
}

func TestOpenScoped_Stats(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "shared.db")

	// Open standalone first to run migrations
	standalone, err := Open(dir, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	standalone.Close()

	// Open shared connection
	conn, err := openConn(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wb := OpenScoped(dir, conn, "proj_test")
	defer wb.Close()

	stats, err := wb.Stats()
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.FindingsTotal != 0 {
		t.Errorf("expected 0 findings, got %d", stats.FindingsTotal)
	}
}
