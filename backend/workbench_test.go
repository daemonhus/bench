package workbench

import (
	"database/sql"
	"fmt"
	"os/exec"
	"path/filepath"
	"testing"

	"bench/internal/model"

	_ "modernc.org/sqlite"
)

func openConn(path string) (*sql.DB, error) {
	return sql.Open("sqlite", path+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)")
}

func TestOpen_And_Stats(t *testing.T) {
	dir := t.TempDir()
	// Use the test dir as a "repo" - git operations will fail but Open should succeed
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

// Re-registering a project on the platform reopens its existing database and
// calls CreateInitialBaseline again; it must not add a second, empty baseline.
func TestCreateInitialBaseline_Idempotent(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	if err := exec.Command("git", "init", "-q", "-b", "main", repo).Run(); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	commit := exec.Command("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
	if out, err := commit.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v: %s", err, out)
	}
	dbPath := filepath.Join(dir, "p.db")
	for i := 0; i < 2; i++ {
		wb, err := Open(repo, dbPath)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		if err := wb.CreateInitialBaseline(); err != nil {
			t.Fatalf("CreateInitialBaseline #%d: %v", i+1, err)
		}
		wb.Close()
	}
	wb, err := Open(repo, dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer wb.Close()
	bls, err := wb.ListBaselines(10)
	if err != nil {
		t.Fatalf("ListBaselines: %v", err)
	}
	if len(bls) != 1 {
		t.Errorf("got %d baselines after two CreateInitialBaseline calls, want 1", len(bls))
	}
}

// The platform sizes projects (risk score, Size column) from Stats' feature counts.
func TestStats_CountsFeatures(t *testing.T) {
	dir := t.TempDir()
	wb, err := Open(dir, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer wb.Close()
	for i, st := range []string{"active", "draft", "deprecated"} {
		f := &model.Feature{ID: fmt.Sprintf("f%d", i), Anchor: model.Anchor{FileID: "a.go", CommitID: "abc"}, Kind: "interface", Title: st, Status: st, Tags: []string{}, CreatedAt: "2026-01-01T00:00:00Z"}
		if err := wb.DB.CreateFeature(f); err != nil {
			t.Fatalf("CreateFeature: %v", err)
		}
	}
	stats, err := wb.Stats()
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.FeaturesTotal != 3 || stats.FeaturesActive != 2 || stats.ByKind["interface"] != 3 {
		t.Errorf("got total=%d active=%d byKind=%v, want 3, 2, interface:3", stats.FeaturesTotal, stats.FeaturesActive, stats.ByKind)
	}
}
