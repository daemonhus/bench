package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
)

// setupBaselineEnv creates a real git repo, a DB, and returns a router + the DB handle.
func setupBaselineEnv(t *testing.T) (http.Handler, *db.DB) {
	t.Helper()
	dir := t.TempDir()

	// Init a real git repo with one commit
	for _, args := range [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@test.com"},
		{"git", "-C", dir, "config", "user.name", "Test"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	// Create a file and commit
	if err := exec.Command("bash", "-c", "echo hello > "+filepath.Join(dir, "readme.txt")).Run(); err != nil {
		t.Fatalf("create file: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "commit", "-m", "initial"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}

	dbPath := filepath.Join(dir, "test.db")
	database, err := db.Open(dbPath, "test")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	repo := git.NewRepo(dir)
	router := NewRouter(repo, database, nil)
	return router, database
}

func TestBaselinesAPI_ListEmpty(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	req := httptest.NewRequest("GET", "/api/baselines", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var list []model.Baseline
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected empty list, got %d", len(list))
	}
}

func TestBaselinesAPI_LatestNotFound(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	req := httptest.NewRequest("GET", "/api/baselines/latest", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestBaselinesAPI_CreateAndGet(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	// Create a baseline
	body := `{"reviewer":"alice","summary":"first pass"}`
	req := httptest.NewRequest("POST", "/api/baselines", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("create status = %d, want 201; body: %s", w.Code, w.Body.String())
	}

	var created model.Baseline
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.ID == "" {
		t.Error("created baseline should have an ID")
	}
	if created.CommitID == "" {
		t.Error("created baseline should have a commit ID (HEAD)")
	}
	if created.Reviewer != "alice" {
		t.Errorf("reviewer = %q, want alice", created.Reviewer)
	}
	if created.Summary != "first pass" {
		t.Errorf("summary = %q, want 'first pass'", created.Summary)
	}
	if created.CreatedAt == "" {
		t.Error("createdAt should be set")
	}
	if created.Seq != 1 {
		t.Errorf("seq = %d, want 1", created.Seq)
	}

	// Latest should return it
	req = httptest.NewRequest("GET", "/api/baselines/latest", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("latest status = %d, want 200", w.Code)
	}
	var latest model.Baseline
	if err := json.NewDecoder(w.Body).Decode(&latest); err != nil {
		t.Fatalf("decode latest: %v", err)
	}
	if latest.ID != created.ID {
		t.Errorf("latest ID = %q, want %q", latest.ID, created.ID)
	}

	// List should contain it
	req = httptest.NewRequest("GET", "/api/baselines", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var list []model.Baseline
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
}

func TestBaselinesAPI_CreateCapturesStats(t *testing.T) {
	router, database := setupBaselineEnv(t)

	// Create some findings first
	for _, f := range []model.Finding{
		{ID: "f1", Anchor: model.Anchor{FileID: "a.go", CommitID: "abc"}, Severity: "high", Title: "SQLi", Status: "open", Source: "mcp"},
		{ID: "f2", Anchor: model.Anchor{FileID: "b.go", CommitID: "abc"}, Severity: "medium", Title: "XSS", Status: "closed", Source: "mcp"},
	} {
		if err := database.CreateFinding(&f); err != nil {
			t.Fatalf("create finding: %v", err)
		}
	}

	// Create baseline — should capture current stats
	req := httptest.NewRequest("POST", "/api/baselines", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
	}

	var bl model.Baseline
	json.NewDecoder(w.Body).Decode(&bl)

	if bl.FindingsTotal != 2 {
		t.Errorf("findingsTotal = %d, want 2", bl.FindingsTotal)
	}
	if bl.FindingsOpen != 1 {
		t.Errorf("findingsOpen = %d, want 1", bl.FindingsOpen)
	}
	if bl.BySeverity["high"] != 1 {
		t.Errorf("bySeverity[high] = %d, want 1", bl.BySeverity["high"])
	}
	if len(bl.FindingIDs) != 2 {
		t.Errorf("findingIDs len = %d, want 2", len(bl.FindingIDs))
	}
}

func TestBaselinesAPI_Delete(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	// Create
	req := httptest.NewRequest("POST", "/api/baselines", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var created model.Baseline
	json.NewDecoder(w.Body).Decode(&created)

	// Dry-run delete (no confirm) — should return 200 with preview
	req = httptest.NewRequest("DELETE", "/api/baselines/"+created.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("dry-run delete status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var preview map[string]any
	json.NewDecoder(w.Body).Decode(&preview)
	if preview["dryRun"] != true {
		t.Fatal("expected dryRun: true in preview response")
	}

	// Baseline should still exist after dry-run
	req = httptest.NewRequest("GET", "/api/baselines", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var listAfterDry []model.Baseline
	json.NewDecoder(w.Body).Decode(&listAfterDry)
	if len(listAfterDry) != 1 {
		t.Fatalf("expected baseline to still exist after dry-run, got %d", len(listAfterDry))
	}

	// Confirmed delete
	req = httptest.NewRequest("DELETE", "/api/baselines/"+created.ID+"?confirm=true", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 204 {
		t.Fatalf("confirmed delete status = %d, want 204; body: %s", w.Code, w.Body.String())
	}

	// List should be empty
	req = httptest.NewRequest("GET", "/api/baselines", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var list []model.Baseline
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 0 {
		t.Errorf("expected empty list after delete, got %d", len(list))
	}
}

func TestBaselinesAPI_Delta(t *testing.T) {
	router, database := setupBaselineEnv(t)

	// Create initial finding
	f := model.Finding{ID: "f1", Anchor: model.Anchor{FileID: "a.go", CommitID: "abc"}, Severity: "high", Title: "SQLi", Status: "open", Source: "mcp"}
	database.CreateFinding(&f)

	// Create baseline (captures f1)
	req := httptest.NewRequest("POST", "/api/baselines", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create baseline: %d %s", w.Code, w.Body.String())
	}

	// Add a new finding after baseline
	f2 := model.Finding{ID: "f2", Anchor: model.Anchor{FileID: "b.go", CommitID: "def"}, Severity: "medium", Title: "XSS", Status: "open", Source: "mcp"}
	database.CreateFinding(&f2)

	// Get delta
	req = httptest.NewRequest("GET", "/api/baselines/delta", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("delta status = %d; body: %s", w.Code, w.Body.String())
	}

	var delta model.BaselineDelta
	if err := json.NewDecoder(w.Body).Decode(&delta); err != nil {
		t.Fatalf("decode delta: %v", err)
	}
	if delta.SinceBaseline == nil {
		t.Fatal("sinceBaseline should not be nil")
	}
	if len(delta.NewFindings) != 1 {
		t.Errorf("newFindings = %d, want 1", len(delta.NewFindings))
	} else if delta.NewFindings[0].ID != "f2" {
		t.Errorf("new finding ID = %q, want f2", delta.NewFindings[0].ID)
	}
	if delta.CurrentStats.FindingsTotal != 2 {
		t.Errorf("currentStats.findingsTotal = %d, want 2", delta.CurrentStats.FindingsTotal)
	}
}

func TestBaselinesAPI_DeltaNoBaseline(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	req := httptest.NewRequest("GET", "/api/baselines/delta", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("delta with no baseline: status = %d, want 404", w.Code)
	}
}

func TestBaselinesAPI_DeltaFor(t *testing.T) {
	router, database := setupBaselineEnv(t)

	// Finding before first baseline
	f1 := model.Finding{ID: "f1", Anchor: model.Anchor{FileID: "a.go", CommitID: "abc"}, Severity: "high", Title: "SQLi", Status: "open", Source: "mcp"}
	database.CreateFinding(&f1)

	// First baseline
	req := httptest.NewRequest("POST", "/api/baselines", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var bl1 model.Baseline
	json.NewDecoder(w.Body).Decode(&bl1)

	// Add another finding
	f2 := model.Finding{ID: "f2", Anchor: model.Anchor{FileID: "b.go", CommitID: "def"}, Severity: "low", Title: "Info leak", Status: "open", Source: "mcp"}
	database.CreateFinding(&f2)

	// Second baseline
	req = httptest.NewRequest("POST", "/api/baselines", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var bl2 model.Baseline
	json.NewDecoder(w.Body).Decode(&bl2)

	// Get delta for bl2 (should compare against bl1)
	req = httptest.NewRequest("GET", "/api/baselines/"+bl2.ID+"/delta", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("deltaFor status = %d; body: %s", w.Code, w.Body.String())
	}

	var delta model.BaselineDelta
	json.NewDecoder(w.Body).Decode(&delta)

	// bl2 has [f1, f2], bl1 has [f1] → f2 is new
	if len(delta.NewFindings) != 1 {
		t.Errorf("newFindings = %d, want 1", len(delta.NewFindings))
	}
	if len(delta.RemovedFindingIDs) != 0 {
		t.Errorf("removedFindingIDs = %d, want 0", len(delta.RemovedFindingIDs))
	}
}

func TestBaselinesAPI_DeltaForNotFound(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	req := httptest.NewRequest("GET", "/api/baselines/nonexistent/delta", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("deltaFor nonexistent: status = %d, want 404", w.Code)
	}
}

func TestBaselinesAPI_DeleteNotFound(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	req := httptest.NewRequest("DELETE", "/api/baselines/nonexistent", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("delete nonexistent: status = %d, want 404", w.Code)
	}
}
